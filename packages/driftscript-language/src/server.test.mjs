/**
 * The language server, driven over the wire.
 *
 * **The transport is the contract, so this spawns the real process and speaks real LSP to it.**
 * Tooling design §12 says no in-process shortcuts for exactly this reason: a test that called the
 * handlers directly would agree with itself about a message shape a real client rejects, and the
 * handlers are the half of this that is already covered — `features.test.ts` and `agreement.test.ts`
 * test what the answers *are*. What is untested without a process is whether an editor can start it,
 * complete a handshake, and get those answers back in a shape it understands.
 *
 * It is `node:test` rather than vitest because vitest only collects `*.test.ts` and this needs to be
 * a process spawning a process. `npm run test:scripts` runs it.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, 'bin', 'server.ts');

/** A minimal LSP client: framed JSON-RPC over the child's stdio, which is all a client is. */
function connect() {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const waiters = [];

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const header = buffer.indexOf('\r\n\r\n');
      if (header < 0) return;
      const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString('ascii'));
      if (match === null) return;
      const length = Number(match[1]);
      const start = header + 4;
      if (buffer.length < start + length) return;
      const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
      buffer = buffer.subarray(start + length);

      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method !== undefined) {
        notifications.push(message);
        for (const waiter of waiters.splice(0)) waiter();
      }
    }
  });

  const send = (payload) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };

  return {
    child,
    notifications,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params });
    },
    /** Wait until `predicate` finds a notification, or give up — a hang here is a failed test. */
    async until(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = notifications.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error('timed out waiting for a notification');
        await new Promise((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 25);
        });
      }
    },
    close() {
      child.kill();
    },
  };
}

const SOURCE = [
  'data PulseState {',
  '    phase: f32 = 0',
  '}',
  '',
  'fn update(state: mut PulseState, dt: f32) {',
  '    state.phase += dt',
  '}',
  '',
].join('\n');

const URI = 'file:///x/pulse.drs';

async function openedClient(text = SOURCE) {
  const client = connect();
  await client.request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', {
    textDocument: { uri: URI, languageId: 'driftscript', version: 1, text },
  });
  return client;
}

test('it completes a handshake and advertises what it can answer', async () => {
  const client = connect();
  try {
    const response = await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
    });
    const capabilities = response.result.capabilities;
    assert.equal(response.result.serverInfo.name, 'driftscript-language');
    assert.equal(capabilities.hoverProvider, true);
    assert.equal(capabilities.definitionProvider, true);
    assert.equal(capabilities.documentSymbolProvider, true);
    assert.deepEqual(capabilities.signatureHelpProvider.triggerCharacters, ['(', ',']);
    /* The legend's order is the wire format, so it is asserted rather than trusted: a reorder
       recolours every token in every file and nothing else would fail. */
    assert.equal(capabilities.semanticTokensProvider.legend.tokenTypes[0], 'keyword');
    assert.ok(capabilities.semanticTokensProvider.legend.tokenTypes.includes('capability'));
  } finally {
    client.close();
  }
});

test('it publishes diagnostics for a file with an error, and clears them when it is fixed', async () => {
  const client = await openedClient('data P {\n    a: f32 = "x"\n}\n');
  try {
    const bad = await client.until((m) => m.method === 'textDocument/publishDiagnostics');
    assert.equal(bad.params.uri, URI);
    assert.equal(bad.params.diagnostics.length, 1);
    assert.equal(bad.params.diagnostics[0].code, 'DS0202');
    assert.equal(bad.params.diagnostics[0].severity, 1);
    /* The span reaches the client as a range, which is the one thing offsets cannot survive. */
    assert.equal(bad.params.diagnostics[0].range.start.line, 1);

    client.notifications.length = 0;
    client.notify('textDocument/didChange', {
      textDocument: { uri: URI, version: 2 },
      contentChanges: [{ text: 'data P {\n    a: f32 = 0\n}\n' }],
    });
    const fixed = await client.until((m) => m.method === 'textDocument/publishDiagnostics');
    assert.deepEqual(fixed.params.diagnostics, []);
  } finally {
    client.close();
  }
});

test('it answers hover, definition and document symbols in editor coordinates', async () => {
  const client = await openedClient();
  try {
    /* Line 4, over `PulseState` in the parameter list. */
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri: URI },
      position: { line: 4, character: 22 },
    });
    assert.match(hover.result.contents.value, /PulseState/);

    const definition = await client.request('textDocument/definition', {
      textDocument: { uri: URI },
      position: { line: 4, character: 22 },
    });
    assert.equal(definition.result.uri, URI);
    assert.equal(definition.result.range.start.line, 0);

    const symbols = await client.request('textDocument/documentSymbol', {
      textDocument: { uri: URI },
      position: { line: 0, character: 0 },
    });
    assert.deepEqual(
      symbols.result.map((s) => s.name),
      ['PulseState', 'update'],
    );
    /* Struct, not a generic symbol — an outline that calls a record "function" is an outline
       nobody trusts. */
    assert.equal(symbols.result[0].kind, 23);
    assert.deepEqual(
      symbols.result[0].children.map((c) => c.name),
      ['phase'],
    );
  } finally {
    client.close();
  }
});

test('it answers signature help with the active parameter', async () => {
  const text = 'fn mix(a: f32, b: f32) {\n}\n\nfn go() {\n    mix(1, 2)\n}\n';
  const client = await openedClient(text);
  try {
    const help = await client.request('textDocument/signatureHelp', {
      textDocument: { uri: URI },
      position: { line: 4, character: 11 },
    });
    assert.equal(help.result.signatures[0].label, 'mix(a: f32, b: f32)');
    assert.equal(help.result.activeParameter, 1);
  } finally {
    client.close();
  }
});

test('it encodes semantic tokens as the five-integer deltas the protocol wants', async () => {
  const client = await openedClient();
  try {
    const tokens = await client.request('textDocument/semanticTokens/full', {
      textDocument: { uri: URI },
    });
    const { data } = tokens.result;
    assert.ok(data.length > 0, 'expected tokens');
    assert.equal(data.length % 5, 0, 'the protocol encodes five integers per token');
    /* The first token starts the file, so its deltas are absolute. */
    assert.equal(data[0], 0);
    assert.equal(data[1], 0);
  } finally {
    client.close();
  }
});

test('it formats a document as one edit over the whole of it', async () => {
  const client = await openedClient('data P {\n  a: f32 = 0\n}\n');
  try {
    const edits = await client.request('textDocument/formatting', {
      textDocument: { uri: URI },
      options: { tabSize: 4, insertSpaces: true },
    });
    assert.equal(edits.result.length, 1);
    assert.match(edits.result[0].newText, /^data P \{\n {4}a: f32 = 0\n\}\n$/);
  } finally {
    client.close();
  }
});

test('it stops publishing for a document that was closed', async () => {
  const client = await openedClient('data P {\n    a: f32 = "x"\n}\n');
  try {
    await client.until((m) => m.method === 'textDocument/publishDiagnostics');
    client.notifications.length = 0;
    client.notify('textDocument/didClose', { textDocument: { uri: URI } });
    const cleared = await client.until((m) => m.method === 'textDocument/publishDiagnostics');
    /* An empty list is how the protocol retracts a squiggle. Without it a closed file's errors sit
       in the problems panel until the editor restarts. */
    assert.deepEqual(cleared.params.diagnostics, []);
  } finally {
    client.close();
  }
});

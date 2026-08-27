/**
 * The protocol shell: a language server over stdio, wrapping the service and deciding nothing.
 *
 * **Everything here is a translation.** The protocol speaks lines and characters and the service
 * speaks byte offsets; the protocol speaks `Position` objects and the service speaks numbers; the
 * protocol has a wire shape for a completion item and the service has a plain record. Not one
 * answer is computed in this file, and that is what keeps the guarantee `service.ts` opens with —
 * a diagnostic the editor shows is a diagnostic the build produces — true through the transport
 * rather than only up to it.
 *
 * **The transport is the contract, so it is tested over the transport.** `server.test.mjs` spawns
 * this file as a process and speaks real LSP to it. An in-process test of the handlers would agree
 * with itself about a message shape that a real client rejects, which is the same failure the
 * agreement test exists to prevent one layer up.
 *
 * Nothing here is registered that the service cannot answer. A server advertising a capability it
 * then answers emptily is worse than one that does not advertise it: an editor shows an empty
 * popup rather than falling back to a word-based suggestion, so the feature reads as broken rather
 * than as absent.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Connection,
  type DocumentSymbol,
  type InitializeResult,
  SymbolKind,
  TextDocumentSyncKind,
  createConnection,
} from 'vscode-languageserver/node';
import type { CapabilityRegistry, TargetManifest } from 'driftscript';
import { type Service, createService } from './service.ts';
import type { SemanticToken } from './features.ts';
import type { Declaration } from './analysis.ts';
import type { Position } from './documents.ts';

/**
 * The token types this server emits, in the order the protocol encodes them.
 *
 * **These are the service's own names, not the protocol's standard set.** `capability` and
 * `annotation` have no standard equivalent and they are the two that make this a DriftScript server
 * rather than a generic one, so translating them into `function` and `decorator` would throw away
 * exactly what is worth showing. The extension maps them to scopes in its manifest.
 *
 * **The index is the wire format**, so this array's order is load-bearing and appending is the only
 * safe edit. A reorder silently recolours every token in every open file and nothing fails: the
 * client is told the legend once, at initialize, and believes it.
 */
export const SEMANTIC_TOKEN_TYPES: readonly SemanticToken['type'][] = [
  'keyword',
  'type',
  'function',
  'capability',
  'number',
  'string',
  'comment',
  'annotation',
  'operator',
  'variable',
];

/** The modifiers that do not depend on a host. Effects are added to these — see `semanticLegend`. */
export const FIXED_TOKEN_MODIFIERS: readonly string[] = ['deterministic', 'hot', 'unavailable'];

/**
 * The legend, with the host's effect names in it.
 *
 * A modifier the legend does not list cannot be encoded, so a server with a fixed list would
 * silently drop every effect a consumer defined — and the effect modifiers are the whole reason
 * these tokens carry more than colour. The effects come from the registry because that is where
 * they are declared, which also means a consumer-defined effect works with no change here.
 *
 * The cost is that the legend depends on the registry, so a client must re-initialize to see an
 * effect added at runtime. What would make that wrong is a registry that grows while an editor is
 * open, which nothing does: it is built once, by the host, at startup.
 */
export function semanticLegend(options: ServerOptions): {
  tokenTypes: string[];
  tokenModifiers: string[];
} {
  const effects = new Set<string>();
  for (const definition of options.registry?.all() ?? []) {
    for (const effect of definition.effects) effects.add(effect);
  }
  return {
    tokenTypes: [...SEMANTIC_TOKEN_TYPES],
    tokenModifiers: [...FIXED_TOKEN_MODIFIERS, ...[...effects].sort()],
  };
}

export interface ServerOptions {
  readonly registry?: CapabilityRegistry;
  readonly manifest?: TargetManifest;
}

/**
 * What the server can see, reported at startup.
 *
 * Tooling design §11: a workspace whose manifest failed to load must say so rather than presenting
 * a completion list that is honest about nothing. `docs-api.mjs` read one barrel of seven and
 * nothing failed, because the count it printed was a true count of what it had looked at — a
 * language server has exactly that shape.
 */
export function coverageLine(options: ServerOptions, openDocuments: number): string {
  const manifest =
    options.manifest === undefined ? 'manifest: none' : `manifest: ${options.manifest.name}`;
  const registry =
    options.registry === undefined
      ? 'registry: none — completion and hover will offer nothing'
      : `registry: ${options.registry.all().length} capabilities`;
  return `DriftScript · ${openDocuments} modules · ${manifest} · ${registry}`;
}

/**
 * Wire a service to a connection.
 *
 * Separated from `startServer` so a test can drive it over any transport, and so the process entry
 * point stays three lines. The connection is not started here; the caller does that, because a
 * caller that wants to register anything else has to do it before `listen`.
 */
export function attachServer(
  connection: Connection,
  options: ServerOptions = {},
): { readonly service: Service } {
  const service = createService({
    ...options,
    /*
     * The disk, for a module nobody has opened.
     *
     * The service reads open documents first and falls back to this, and it cannot reach a
     * filesystem itself: it runs in an editor's process and its own config sets `types: []`. So the
     * process that *is* Node supplies it, which is this one.
     *
     * A uri is not a path. Editors speak `file:///a/b.drs` and `readFileSync` wants `/a/b.drs`, and
     * anything else — an untitled buffer, a remote scheme — is not on this disk at all and answers
     * null, which becomes DS0501 rather than an exception.
     */
    readFile: (id) => {
      if (!id.startsWith('file://')) return null;
      try {
        return readFileSync(fileURLToPath(id), 'utf8');
      } catch {
        return null;
      }
    },
  });
  /** Text keyed by uri, so a `didChange` can be applied without asking the client to resend. */
  const open = new Set<string>();

  const positionOf = (uri: string, position: Position): number =>
    service.document(uri)?.offsetAt(position) ?? 0;

  const publish = (uri: string): void => {
    const document = service.document(uri);
    if (document === undefined) return;
    void connection.sendDiagnostics({
      uri,
      diagnostics: service.diagnostics(uri).map((d) => ({
        range: d.range,
        severity: d.severity === 'error' ? 1 : 2,
        code: d.code,
        source: 'driftscript',
        message: d.message,
      })),
    });
  };

  connection.onInitialize((): InitializeResult => {
    return {
      capabilities: {
        /*
         * Full sync rather than incremental.
         *
         * The service rebuilds a document's line index on every edit anyway — `documents.ts` says
         * why — so incremental sync would save the transport and not the work, and it would add the
         * one thing this file is trying not to have: a place where the server's idea of the text
         * can drift from the client's. What would make it wrong is a file large enough for the
         * transport to matter, which a behaviour script is not.
         */
        textDocumentSync: TextDocumentSyncKind.Full,
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: true,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        codeActionProvider: true,
        completionProvider: { triggerCharacters: ['.'] },
        signatureHelpProvider: { triggerCharacters: ['(', ','] },
        semanticTokensProvider: { legend: semanticLegend(options), full: true },
      },
      serverInfo: { name: 'driftscript-language' },
    };
  });

  connection.onInitialized(() => {
    connection.console.log(coverageLine(options, open.size));
  });

  connection.onDidOpenTextDocument((params) => {
    service.open(params.textDocument.uri, params.textDocument.text);
    open.add(params.textDocument.uri);
    publish(params.textDocument.uri);
  });

  connection.onDidChangeTextDocument((params) => {
    /* Full sync, so the last change carries the whole document. */
    const last = params.contentChanges[params.contentChanges.length - 1];
    if (last === undefined) return;
    service.change(params.textDocument.uri, last.text);
    publish(params.textDocument.uri);

    /*
     * Republish every dependent the scheduler names.
     *
     * A file whose interface moved changes what its dependents mean, and their published
     * diagnostics are stale from that moment. Today the graph is empty and this recompiles the
     * edited file alone, which is what `schedule.ts` documents; it starts doing more the day the
     * language grows file imports, and this line does not change.
     */
    for (const dependent of service.schedule(params.textDocument.uri).recompile) {
      if (dependent !== params.textDocument.uri && open.has(dependent)) publish(dependent);
    }
  });

  connection.onDidCloseTextDocument((params) => {
    service.close(params.textDocument.uri);
    open.delete(params.textDocument.uri);
    /* An empty list is how the protocol says "no problems here any more". Without it the squiggles
       of a closed file stay in the problems panel until the editor is restarted. */
    void connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
  });

  connection.onHover((params) => {
    const uri = params.textDocument.uri;
    const document = service.document(uri);
    const result = service.hover(uri, positionOf(uri, params.position));
    if (result === null || document === undefined) return null;
    return { contents: { kind: 'markdown', value: result.contents }, range: document.rangeOf(result.span) };
  });

  connection.onDefinition((params) => {
    const uri = params.textDocument.uri;
    const document = service.document(uri);
    const result = service.definition(uri, positionOf(uri, params.position));
    if (result === null || document === undefined) return null;
    return { uri: result.uri, range: document.rangeOf(result.span) };
  });

  connection.onReferences((params) => {
    const uri = params.textDocument.uri;
    const document = service.document(uri);
    if (document === undefined) return [];
    return service
      .references(uri, positionOf(uri, params.position))
      .map((span) => ({ uri, range: document.rangeOf(span) }));
  });

  connection.onRenameRequest((params) => {
    const uri = params.textDocument.uri;
    const document = service.document(uri);
    if (document === undefined) return null;
    const result = service.rename(uri, positionOf(uri, params.position), params.newName);
    /*
     * A refused rename answers null rather than an empty edit.
     *
     * `edits.ts` refuses to rename across the registry boundary — a capability's name belongs to
     * the host, not to the file using it. An empty `WorkspaceEdit` would report success and change
     * nothing, which is the silent no-op `AGENTS.md` forbids. Null makes the client say the rename
     * cannot be applied.
     */
    if (!result.renamed) return null;
    return {
      changes: {
        [uri]: result.edits.map((edit) => ({
          range: document.rangeOf(edit.span),
          newText: edit.text,
        })),
      },
    };
  });

  connection.onDocumentSymbol((params) => {
    const uri = params.textDocument.uri;
    const document = service.document(uri);
    if (document === undefined) return [];
    /* The protocol's `SymbolKind` numbers. `data` is Struct, `enum` is Enum, `fn` is Function,
       `field` is Field and a variant is EnumMember — the closest honest match for each, so an
       outline shows a record as a record rather than as a generic symbol. */
    const KIND: Readonly<Record<Declaration['kind'], SymbolKind>> = {
      data: SymbolKind.Struct,
      enum: SymbolKind.Enum,
      fn: SymbolKind.Function,
      field: SymbolKind.Field,
      variant: SymbolKind.EnumMember,
      constant: SymbolKind.Constant,
    };
    const convert = (declaration: Declaration): DocumentSymbol => ({
      name: declaration.name,
      detail: declaration.detail,
      kind: KIND[declaration.kind],
      range: document.rangeOf(declaration.span),
      selectionRange: document.rangeOf(declaration.nameSpan),
      children: declaration.children.map(convert),
    });
    return service.documentSymbols(uri).map(convert);
  });

  connection.onDocumentFormatting((params) => {
    const uri = params.textDocument.uri;
    const document = service.document(uri);
    const text = service.formatting(uri);
    if (document === undefined || text === undefined || text === document.text) return [];
    /* One edit over the whole document. The formatter does not reflow, so a minimal diff would be
       smaller — and computing one here would be a second implementation of what the formatter
       already decided. */
    return [{ range: document.rangeOf({ start: 0, end: document.text.length }), newText: text }];
  });

  connection.onCompletion((params) => {
    const uri = params.textDocument.uri;
    return service.completions(uri, positionOf(uri, params.position)).map((item) => ({
      label: item.label,
      detail: item.detail,
      /*
       * An unavailable capability is offered and marked, never hidden.
       *
       * Tooling design §7: a completion list is a claim about what exists, and hiding what the
       * target does not provide would teach an author that a capability is not there when it is
       * merely not linked. `deprecated` is the only tag the protocol has for "shown, struck
       * through", which is not what it means here and is what every client renders the way this
       * needs. The cost is a word in the detail line doing the real work.
       */
      tags: item.available ? undefined : [1],
      sortText: item.available ? '0' : '1',
    }));
  });

  connection.onSignatureHelp((params) => {
    const uri = params.textDocument.uri;
    const help = service.signatureHelp(uri, positionOf(uri, params.position));
    if (help === null) return null;
    return {
      signatures: [
        {
          label: help.label,
          documentation: help.documentation,
          parameters: help.parameters.map((label) => ({ label })),
        },
      ],
      activeSignature: 0,
      activeParameter: help.activeParameter,
    };
  });

  connection.languages.semanticTokens.on((params) => {
    const uri = params.textDocument.uri;
    const document = service.document(uri);
    if (document === undefined) return { data: [] };

    /*
     * The protocol encodes tokens as deltas, five integers each, relative to the previous token.
     * Encoding it here rather than in `features.ts` keeps the wire format out of the feature: a
     * second client with a different encoding reuses the tokens and replaces this loop.
     */
    const legend = semanticLegend(options);
    const data: number[] = [];
    let previousLine = 0;
    let previousStart = 0;
    for (const token of service.semanticTokens(uri)) {
      const { line, character } = document.positionAt(token.span.start);
      const deltaLine = line - previousLine;
      /* A modifier the legend does not carry is dropped rather than encoded as index 0, which would
         mark it `deterministic` — a wrong answer where none is the honest one. `semanticLegend`
         builds the list from the registry so this should never fire; it is here because encoding a
         wrong bit is worse than encoding nothing. */
      let mask = 0;
      for (const name of token.modifiers) {
        const index = legend.tokenModifiers.indexOf(name);
        if (index >= 0) mask |= 1 << index;
      }
      data.push(
        deltaLine,
        deltaLine === 0 ? character - previousStart : character,
        token.span.end - token.span.start,
        Math.max(0, legend.tokenTypes.indexOf(token.type)),
        mask,
      );
      previousLine = line;
      previousStart = character;
    }
    return { data };
  });

  connection.onCodeAction((params) => {
    const uri = params.textDocument.uri;
    const document = service.document(uri);
    if (document === undefined) return [];
    return service.codeActions(uri).map((action) => ({
      /* A change a consumer must make outside this file is named in the title, because the edit
         cannot perform it and an action that silently does half its job is worse than one that
         says which half. */
      title: action.manual === undefined ? action.title : `${action.title} (${action.manual})`,
      kind: 'quickfix',
      edit: {
        changes: {
          [uri]: action.edits.map((edit) => ({
            range: document.rangeOf(edit.span),
            newText: edit.text,
          })),
        },
      },
    }));
  });

  return { service };
}

/**
 * The process entry point: a connection over stdio, wired and listening.
 *
 * **The streams are passed explicitly rather than left to the command line.** `createConnection()`
 * with no arguments throws unless the client passed `--stdio`, `--node-ipc` or `--socket`, so a
 * server that relied on the flag would start under one client and die at launch under another —
 * and an editor whose server dies at launch shows no diagnostics and no reason. Naming the streams
 * makes the transport a property of this server rather than of whoever started it.
 *
 * The cost is that this server is stdio and cannot be asked for a socket. What would make that
 * wrong is a client that cannot spawn a process — a browser-hosted editor — which is a different
 * entry point rather than a flag on this one.
 */
export function startServer(options: ServerOptions = {}): void {
  const connection = createConnection(process.stdin, process.stdout);
  attachServer(connection, options);
  connection.listen();
}

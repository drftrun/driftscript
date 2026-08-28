/**
 * The VSCode extension contributes the *generated* grammar, and nothing else defines the language.
 *
 * The grammar is copied at package time and never committed twice. A second checked-in copy is a
 * second definition, and it goes stale the Friday somebody adds a keyword — silently, which is the
 * whole reason it is generated rather than reviewed.
 *
 * So this holds three things a copy would break: the manifest points at the copy destination, the
 * copy source is the generated file, and the destination is not in git.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(ROOT, 'editors', 'vscode');
const manifest = JSON.parse(readFileSync(path.join(EXTENSION, 'package.json'), 'utf8'));

const { GENERATED, DESTINATION } = await import(
  path.join(EXTENSION, 'scripts', 'copy-grammar.mjs')
);

test('the contributed grammar is the one the copy step writes', () => {
  const contributed = manifest.contributes.grammars[0].path;
  assert.equal(
    path.resolve(EXTENSION, contributed),
    path.resolve(DESTINATION),
    'the manifest must point at the copy destination, or the copy step fills a file nobody reads',
  );
});

test('the copy source is the generated grammar, not a second definition', () => {
  assert.equal(
    path.resolve(GENERATED),
    path.resolve(ROOT, 'packages/driftscript/src/tooling/grammar/generated/driftscript.tmLanguage.json'),
  );
  assert.ok(existsSync(GENERATED), 'the generated grammar must exist — run `npm run grammar`');
});

test('the copied grammar is not committed, so there is only ever one definition', () => {
  const tracked = execFileSync('git', ['ls-files', 'editors/vscode/syntaxes'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  assert.equal(
    tracked,
    '',
    `a committed grammar copy is a second definition of the language:\n${tracked}`,
  );
});

test('the language contributes .drs, and an icon for it', () => {
  const language = manifest.contributes.languages[0];
  assert.equal(language.id, 'driftscript');
  assert.deepEqual(language.extensions, ['.drs']);
  for (const variant of ['light', 'dark']) {
    const icon = path.resolve(EXTENSION, language.icon[variant]);
    assert.ok(existsSync(icon), `the ${variant} icon must exist at ${language.icon[variant]}`);
  }
});

/**
 * The icons parse, and one rule is worth naming because it caught a real break.
 *
 * **A double hyphen is illegal inside an XML comment.** These files carry a paragraph explaining the
 * mark, and the first version of that paragraph quoted a CSS custom property by name — two hyphens,
 * inside the comment, which makes the whole document unparseable. Nothing else here would have
 * noticed: the file is read only by VSCode, which renders no icon and reports nothing, so the symptom
 * is a `.drs` file wearing the generic icon — indistinguishable from a theme that does not defer to
 * language icons, which is the ordinary case.
 *
 * Quote a custom property as `ds-accent` in these files, or say "the accent token" and mean it.
 *
 * **This is not a full XML parse, and saying so is the point.** Node ships no XML parser and no
 * `DOMParser`, and pulling one in as a dependency to check two hand-written files would cost more
 * than it is worth. What is checked is the rule that broke, plus the structure a hand-edited SVG
 * plausibly loses: the root element, and comments that close. A malformed attribute would get past
 * this, and the honest mitigation for that is that these files are twenty lines long and get looked
 * at.
 */
test('each icon parses as far as this can check, including the rule that broke', () => {
  const language = manifest.contributes.languages[0];
  for (const variant of ['light', 'dark']) {
    const name = language.icon[variant];
    const text = readFileSync(path.resolve(EXTENSION, name), 'utf8').trim();

    const opens = (text.match(/<!--/g) ?? []).length;
    const closes = (text.match(/-->/g) ?? []).length;
    assert.equal(opens, closes, `${name}: ${opens} comment openers and ${closes} closers`);

    for (const [, body] of text.matchAll(/<!--([\s\S]*?)-->/g)) {
      assert.ok(
        !body.includes('--'),
        `${name}: a comment contains \`--\`, which makes the file unparseable and the icon ` +
          'silently absent. Write `ds-accent`, not the custom property with its hyphens.',
      );
    }

    assert.match(text, /^<svg\b/, `${name} must be an <svg> at the root`);
    assert.match(text, /<\/svg>$/, `${name} must close its root element`);
    assert.match(text, /viewBox="/, `${name} needs a viewBox, or it will not scale to 16px`);
  }
});

/**
 * Both variants draw the same mark, and only the colour differs.
 *
 * The reason there are two files at all is contrast: DriftScript's accent measures 7.90:1 against
 * VSCode's dark tree and 1.88:1 against its light one, so the light variant deepens the lightness and
 * holds the hue. If the geometry ever diverges, one of them has been edited and the other forgotten,
 * and the symptom is a mark that changes shape with the theme.
 */
test('the two icon variants differ only in colour', () => {
  const language = manifest.contributes.languages[0];
  const geometry = (variant) =>
    readFileSync(path.resolve(EXTENSION, language.icon[variant]), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .match(/ d="([^"]+)"/)?.[1];

  assert.ok(geometry('dark'), 'the dark icon has no path');
  assert.equal(geometry('light'), geometry('dark'), 'the two variants have drifted apart');
});

test('the entry point is JavaScript, because an extension host cannot load TypeScript', () => {
  /*
   * An extension host `require`s `main`, and that has to be JavaScript. A manifest pointing at a
   * `.ts` file loads under neither the host nor the debugger, and the failure is an extension that
   * simply never activates.
   */
  assert.match(manifest.main, /\.cjs$/);
  assert.equal(manifest.scripts.build, 'node ./scripts/build.mjs');
  assert.ok(existsSync(path.join(EXTENSION, 'scripts', 'build.mjs')));
});

test('the bundle is not committed, for the same reason the grammar is not', () => {
  const tracked = execFileSync('git', ['ls-files', 'editors/vscode/out'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  assert.equal(tracked, '', `a committed bundle is a second copy of the client:\n${tracked}`);
});

test('the server the client starts in a checkout is really there', () => {
  /* The development path: the client walks up from its own file to this. If it moves, the extension
     starts nothing, so the path is asserted rather than trusted. */
  assert.ok(
    existsSync(path.join(ROOT, 'packages', 'driftscript-language', 'src', 'bin', 'server.ts')),
    'the client resolves this path relative to itself; moving it breaks activation silently',
  );
});

/**
 * The client can find a server when there is no checkout, which is the only way anybody who did not
 * clone this gets one.
 *
 * **This is the property that was missing, and its absence was the real reason the extension was
 * unpublishable.** The walk-up path lands in `~/.vscode` from a marketplace install and finds
 * nothing, so the extension would activate, start no server, and leave every `.drs` file looking
 * like a language server with no opinions.
 *
 * The server is **bundled** rather than depended on, which was the second attempt. The first
 * declared `driftscript-language` in `dependencies`; `vsce` then followed the workspace symlink out
 * of the extension folder and refused to package at all. `scripts/build.mjs` explains it where the
 * fix lives.
 */
test('the client falls back to a bundled server, which the build emits', () => {
  const source = readFileSync(path.join(EXTENSION, 'src', 'extension.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  assert.match(
    source,
    /path\.join\(__dirname, 'server\.mjs'\)/,
    'the fallback has to be a file the build puts beside the client',
  );

  /* Declaring it instead is the design that cannot be packaged. */
  assert.equal(
    manifest.dependencies?.['driftscript-language'],
    undefined,
    'the server is bundled, not depended on — see scripts/build.mjs for why vsce refuses the other way',
  );

  const build = readFileSync(path.join(EXTENSION, 'scripts', 'build.mjs'), 'utf8');
  assert.match(build, /'server\.mjs'/, 'the build must emit the server bundle the client falls back to');
  assert.match(
    build,
    /createRequire/,
    'an ESM bundle has no `require`, and `vscode-languageserver` is CommonJS and calls one — ' +
      'without the shim the server dies on startup and nothing else notices',
  );
});

/**
 * A document using the newest forms, opened against the packed server.
 *
 * **Every line here is something a previous client could not parse**, which is the only reason a
 * line is in it: module constants, a list with its literal and its walk, `break`, a component row
 * as a parameter, a component reached through a handle, and a system's `uses` clause. When the
 * language grows a form, it is added here, and the day the packed client is older than the compiler
 * this fails with the code it produced rather than with a reminder to check by hand.
 */
const CURRENT_FORMS = `let LIMIT = 3

component Placement {
    speed: f32 = 0
}

fn advance(p: mut Placement, by: f32) {
    p.speed = p.speed + by
}

fn total(xs: List<f32>) -> f32 {
    var sum = 0
    for x in xs {
        if x > LIMIT {
            break
        }
        sum += x
    }
    return sum
}

system Walk {
    uses graph: NavGraph
    writes Placement

    update at 2Hz {
        for e in query<Placement>() {
            advance(e.Placement, 1)
        }
    }
}
`;

/**
 * The extension packages, and the server inside the package starts.
 *
 * **Every earlier version of this passed while the extension was unusable**, which is why this test
 * spawns a process instead of reading files. Two failures got through everything else:
 * `vsce` refusing to package because a hoisted `node_modules` climbs out of the extension folder,
 * and then a bundle that built cleanly and died on its first line with `Dynamic require of
 * "node:util" is not supported`. Neither changed a type, a lint or a unit test.
 *
 * It is the same assertion `scripts/publish-check.mjs` makes about the npm packages, for the same
 * reason: the artefact a stranger receives is the only thing worth checking.
 *
 * ---
 *
 * **It also opens a document and reads the diagnostics back, which is the half that decides whether
 * the client has to be re-cut.** A bundled server is frozen at the moment the `.vsix` was packed,
 * so the question `docs/RELEASING.md` asks every release is what a server of that vintage would say
 * about code somebody can write today — and its first case is the one that matters: *it cannot
 * parse the syntax*, so a whole valid document goes red and stays red.
 *
 * That was checked by hand twice and it is a claim that drifts, which is what this file is for. The
 * document below uses the newest forms; a syntax refusal against it means the packed server is
 * older than the language and the client needs packing again. **A `DS02xx` is not a failure here**
 * — this server is started with no host at all, so a name only a registry could supply is expected
 * to be unknown, and asserting otherwise would be asserting that the language server has a host.
 */
test('the packaged extension carries a server that starts and parses today\'s syntax', async () => {
  const out = path.join(EXTENSION, 'out', 'server.mjs');
  assert.ok(
    existsSync(out),
    'run `npm run extension` first — this measures what the build emits, not what the source says',
  );

  const room = mkdtempSync(path.join(tmpdir(), 'driftscript-vsix-'));
  try {
    const vsix = path.join(room, 'extension.vsix');
    const packed = spawnSync(
      path.join(ROOT, 'node_modules', '.bin', 'vsce'),
      ['package', '--no-dependencies', '--no-git-tag-version', '--out', vsix],
      { cwd: EXTENSION, encoding: 'utf8' },
    );
    assert.equal(
      packed.status,
      0,
      `vsce refused to package:\n${(packed.stdout ?? '') + (packed.stderr ?? '')}`.slice(-800),
    );

    execFileSync('unzip', ['-q', vsix, '-d', room], { stdio: 'pipe' });
    const server = path.join(room, 'extension', 'out', 'server.mjs');
    assert.ok(existsSync(server), 'the .vsix carries no server; .vscodeignore has excluded it');

    const { error, diagnostics } = await new Promise((resolve) => {
      const child = spawn('node', [server], { stdio: ['pipe', 'pipe', 'pipe'] });
      const send = (message) => {
        const body = JSON.stringify({ jsonrpc: '2.0', ...message });
        child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      };

      /* Buffers rather than a string, because `Content-Length` counts bytes and the server's own
         startup log carries multi-byte characters — slicing a string by a byte count cuts a frame
         in half, which is a parse error in the test rather than a finding about the server. */
      let buffer = Buffer.alloc(0);
      let stderr = '';
      const give = setTimeout(
        () => finish(`no diagnostics in 30s. stderr: ${stderr.slice(0, 300)}`),
        30_000,
      );
      const finish = (message, published) => {
        clearTimeout(give);
        child.kill();
        resolve({ error: message, diagnostics: published });
      };

      child.stdout.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const head = buffer.indexOf('\r\n\r\n');
          if (head < 0) return;
          const length = Number(
            /Content-Length: (\d+)/.exec(buffer.subarray(0, head).toString())?.[1],
          );
          if (!Number.isFinite(length) || buffer.length < head + 4 + length) return;
          const message = JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString());
          buffer = buffer.subarray(head + 4 + length);

          if (message.id === 1) {
            send({ method: 'initialized', params: {} });
            send({
              method: 'textDocument/didOpen',
              params: {
                textDocument: {
                  uri: 'file:///packed.drs',
                  languageId: 'driftscript',
                  version: 1,
                  text: CURRENT_FORMS,
                },
              },
            });
          }
          if (message.method === 'textDocument/publishDiagnostics') {
            finish(undefined, message.params.diagnostics);
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (problem) => finish(problem.message));
      child.on('exit', (code) => finish(`exited with ${code}. stderr: ${stderr.slice(0, 400)}`));

      send({
        id: 1,
        method: 'initialize',
        params: { processId: process.pid, rootUri: null, capabilities: {} },
      });
    });

    assert.equal(error, undefined, `the bundled server did not answer: ${error}`);

    /* Lexical and syntactic only. A `DS02xx` about a name no registry supplied is what a server
       with no host is supposed to say, and it is not what a re-cut would fix. */
    const refused = (diagnostics ?? []).filter((d) => /^DS0(0|1)\d\d$/.test(String(d.code ?? '')));
    assert.deepEqual(
      refused.map((d) => `${d.code} ${d.message}`),
      [],
      'the packed server cannot parse a form the language has. It is older than the compiler in ' +
        'this checkout, so `npm run extension` and `npm run vsix` again — see the re-cut rules in ' +
        'docs/RELEASING.md.',
    );
  } finally {
    rmSync(room, { recursive: true, force: true });
  }
});

/**
 * The listing has everything a marketplace card needs.
 *
 * None of these is something `vsce` refuses to package without, which is why they are checked here:
 * a listing with no icon gets a grey placeholder, and one with no keywords cannot be found by
 * searching for the language it supports. Both are invisible until the page is live.
 */
test('the manifest carries what a marketplace listing renders', () => {
  assert.ok(manifest.icon, 'no `icon`: the listing would show a grey placeholder');
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0, 'no `keywords`');
  assert.ok(manifest.repository?.url, 'no `repository`: relative links in the README cannot resolve');
  assert.ok(manifest.license, 'no `license`');

  const icon = path.resolve(EXTENSION, manifest.icon);
  assert.ok(existsSync(icon), `the icon is missing at ${manifest.icon}`);

  /*
   * The marketplace floor is 128x128. Read straight out of the PNG header — width and height are
   * big-endian 32-bit at offsets 16 and 20 — because the alternative is an image library in the
   * dependency tree to check two numbers.
   */
  const header = readFileSync(icon);
  assert.equal(header.subarray(1, 4).toString(), 'PNG', 'the marketplace icon must be a PNG');
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  assert.ok(
    width >= 128 && height >= 128,
    `the icon is ${width}x${height} and the marketplace floor is 128x128`,
  );
});

/**
 * Whether the extension is listed, and every document that says so, agree.
 *
 * **Two states, and the point is that publishing does not have to break this.** An earlier version
 * pinned `publisher` to the placeholder, so setting a real one turned the suite red at exactly the
 * moment somebody was trying to release — a gate that fires on the intended action teaches people to
 * delete gates.
 *
 * **And it checks every document, not the extension's own README.** The claim lives in four places:
 * the root README's package table, the extension's README, and two paragraphs of the changelog.
 * Asserting one of them is how three stale sentences ship — which is the same failure as the reason
 * that rotted here for weeks, in a different costume.
 *
 * `docs/RELEASING.md` is exempt and that is deliberate: it is the procedure, and a procedure has to
 * be able to name the thing it checks for.
 *
 * `private` stays `true` in both states. It is npm's field, `vsce` ignores it, and it is what stops
 * the extension reaching the wrong registry by accident.
 */
const UNLISTED_CLAIMS = [
  /not on the marketplace/i,
  /not listed/i,
  /still unpublished/i,
  /is not published at all/i,
];

/** Where a product claim about the extension can legitimately appear. */
const CLAIM_FILES = [
  'README.md',
  'CHANGELOG.md',
  'editors/vscode/README.md',
  'packages/driftscript/README.md',
  'packages/driftscript-language/README.md',
];

/*
 * A whole italicised paragraph may quote a claim in order to say it expired. Stripping those is what
 * lets the history stay on the page after the fact it described stops being true.
 */
const asserted = (file) =>
  readFileSync(path.join(ROOT, file), 'utf8').replace(/^\*[^*][\s\S]*?\*$/gm, ' ');

test('the listing state and every document that claims it agree', () => {
  assert.equal(manifest.private, true, 'npm must still refuse this package');

  const claiming = CLAIM_FILES.filter((file) =>
    UNLISTED_CLAIMS.some((pattern) => pattern.test(asserted(file))),
  );

  if (manifest.publisher === 'unpublished') {
    assert.ok(
      claiming.includes('editors/vscode/README.md'),
      'while the publisher is a placeholder, the extension README has to say it is not listed',
    );
    return;
  }

  assert.deepEqual(
    claiming,
    [],
    `\`publisher\` is "${manifest.publisher}", so the extension is listed and these still say it ` +
      `is not:\n  ${claiming.join('\n  ')}\n` +
      'The extension README also needs its "Loading it" section demoted: an installed extension ' +
      'needs no symlink, and that section is now the contributor path.',
  );
});

/**
 * The reasons that expired, kept out of the present tense.
 *
 * Two of them. *The engine is closed, so a listing would advertise a language nobody outside can
 * run* stopped being true the day `driftscript` reached npm. The commercial one that replaced it —
 * a publisher identity and a support commitment nobody had agreed to — was not the blocker at all,
 * because the client could not find a server outside a checkout.
 *
 * Either may be quoted in an italicised note that says it expired. Neither may be stated as current.
 */
const EXPIRED_REASONS = [
  /would advertise a language nobody outside c(?:an|ould) run/,
  /none of (?:those|them) has been chosen/i,
];

test('no expired reason is stated as current', () => {
  const offences = [];
  for (const file of CLAIM_FILES) {
    for (const expired of EXPIRED_REASONS) {
      if (expired.test(asserted(file))) offences.push(`${file}: ${expired}`);
    }
  }
  assert.deepEqual(
    offences,
    [],
    `these reasons expired. They may be quoted in a note saying so, not stated as current:\n  ${offences.join('\n  ')}`,
  );
});

test('the semantic token types it declares are ones the server actually emits', () => {
  /*
   * The two custom types are the point of this extension — a generic client colours a capability
   * call as a function and loses the only thing worth showing. A declared type the server never
   * sends is dead configuration; one the server sends and this does not declare falls back to no
   * colour at all, which reads as the feature being off.
   */
  const server = readFileSync(
    path.join(ROOT, 'packages/driftscript-language/src/server.ts'),
    'utf8',
  );
  for (const declared of manifest.contributes.semanticTokenTypes.map((t) => t.id)) {
    assert.ok(server.includes(`'${declared}'`), `the server never emits \`${declared}\``);
  }
  for (const declared of manifest.contributes.semanticTokenModifiers.map((t) => t.id)) {
    assert.ok(server.includes(`'${declared}'`), `the server never emits \`${declared}\``);
  }
});

/**
 * The client names no host of its own.
 *
 * It defaulted to the engine's generated `capabilities.json` while it lived in the engine's
 * repository. Here that path resolves to nothing, and a default pointing at a file that cannot
 * exist produces a warning on every activation that reads as a broken extension rather than an
 * unconfigured one.
 */
test('the client hard-codes no capability file', () => {
  const source = readFileSync(path.join(EXTENSION, 'src', 'extension.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  assert.ok(
    !source.includes('capabilities.json'),
    'DriftScript ships no host, so there is no capability file to default to',
  );
});

/**
 * Bundle the client and the server to JavaScript, because a VSCode extension host cannot load
 * TypeScript and a `.vsix` cannot carry a workspace symlink.
 *
 * **Two outputs, and the second one is the whole reason this extension is installable.** The client
 * walks up from its own file to find the server's source, which is right in a checkout and lands in
 * `~/.vscode` from a marketplace install — so an installed extension has to carry a server of its
 * own.
 *
 * **The first attempt made it a runtime dependency and that does not survive packaging.** `vsce`
 * follows `node_modules/driftscript-language`, which in this workspace is a symlink to
 * `packages/driftscript-language`, walks out of the extension folder and tries to pack the whole
 * repository — 1,144 files, and then a hard error on `extension/../../vitest.config.ts`. That is the
 * same workspace-symlink trap that made the language itself unpublishable, arriving a third time in
 * a third tool. Bundling has no symlink in it.
 *
 * The two bundles are separate on purpose. They run in different processes: the client lives in the
 * extension host, and the server is spawned. Putting the compiler in the client's bundle would load
 * a parser into the editor's own process to no purpose, and `out/extension.cjs` is what `main`
 * names.
 *
 * CommonJS for the client, because the extension host loads extensions with `require`. **ESM for the
 * server, and not by preference:** `bin/server.ts` awaits a dynamic import at its top level to load
 * a `--host` module, and top-level await does not exist in CommonJS.
 *
 * Neither output is committed. A committed bundle would be a second copy that goes stale exactly the
 * way a committed grammar would, which is the argument `copy-grammar.mjs` makes about the other
 * generated artefact here.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(HERE, '..');
const REPO = path.join(EXTENSION, '..', '..');

/* The client. `vscode` is injected by the host at runtime and is absent from disk, so bundling it
   would fail; leaving it external is what every VSCode extension does. */
await build({
  entryPoints: [path.join(EXTENSION, 'src', 'extension.ts')],
  outfile: path.join(EXTENSION, 'out', 'extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});

/*
 * The server, from the sibling package's source rather than from an installed copy.
 *
 * A relative path across the monorepo, which is exactly what `scripts/boundaries.test.mjs` refuses
 * for a *published* package and is correct here: this is a build step in the same repository, and
 * the alternative — a declared dependency — is the thing that broke packaging.
 *
 * It is deliberately not minified. This is a development tool, and a stack trace out of a language
 * server is read by whoever is debugging one.
 */
await build({
  entryPoints: [path.join(REPO, 'packages', 'driftscript-language', 'src', 'bin', 'server.ts')],
  outfile: path.join(EXTENSION, 'out', 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  /*
   * `require`, put back, because an ESM bundle does not have one and this graph needs it.
   *
   * `vscode-languageserver` is CommonJS and calls `require('node:util')`. esbuild cannot turn that
   * into a static import, so it emits a stub that throws `Dynamic require of "node:util" is not
   * supported` — at *runtime*, on the first line that reaches it, which is server startup. The
   * bundle builds cleanly and the extension then starts a process that dies immediately.
   *
   * **Found by spawning the bundle out of a packed `.vsix` and sending it an LSP initialize**, which
   * is the only thing that could have found it: nothing about the build, the types or the test suite
   * is different when this is missing. `scripts/publish-check.mjs` does the same spawn for the npm
   * package, and for the same reason.
   */
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  sourcemap: true,
  logLevel: 'info',
});

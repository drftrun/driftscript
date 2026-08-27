/**
 * What a consumer installs, built from what this repository edits.
 *
 * **This build is the reason there is a publishable package at all.** The source names `.ts` on
 * every relative import, deliberately, so that `node` can load the Vite plugin and the compiler
 * straight out of a checkout. Node refuses to strip types for any file under `node_modules` —
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, a categorical refusal rather than a resolution
 * failure — so a package that shipped that source would work perfectly for everybody developing it
 * and fail on the first import for everybody installing it. That is exactly what happened, and it
 * was invisible because a workspace resolves the package through a symlink whose real path has no
 * `node_modules` segment in it.
 *
 * So: `tsc` with `rewriteRelativeImportExtensions`, which is a type strip with no code generation
 * anywhere in it — the property the source already has and the tests already hold.
 *
 * Order matters. `driftscript-language` resolves `driftscript` through the workspace, and after
 * this runs that resolution lands on `dist/`, so the language package cannot be built first.
 *
 * Usage:
 *   node scripts/build.mjs               both packages, in order
 *   node scripts/build.mjs driftscript   one of them
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const TSC = path.join(ROOT, 'node_modules', '.bin', 'tsc');

/** The build order, which is a dependency order and not an alphabetical one. */
const ORDER = ['driftscript', 'driftscript-language'];

/**
 * Files that are not TypeScript and therefore not emitted, copied in beside what is.
 *
 * `drs.d.ts` is an ambient declaration: `tsc` reads it and never writes it, and a consumer needs
 * it to resolve `import * as door from './door.drs'`. It is reachable as `driftscript/drs`, so one
 * `/// <reference types="driftscript/drs" />` replaces the block of `declare module` a consumer
 * used to have to copy out of the README.
 *
 * `grammar.json` is the TextMate grammar generated from the compiler's own token table. It ships
 * because an editor that is not VSCode should not have to re-derive the language's keywords by
 * reading the lexer.
 */
const ASSETS = {
  driftscript: [
    ['src/drs.d.ts', 'dist/drs.d.ts'],
    ['src/tooling/grammar/generated/driftscript.tmLanguage.json', 'dist/grammar.json'],
  ],
  'driftscript-language': [],
};

/**
 * The changelog, copied into each package so it travels in the tarball.
 *
 * **One copy, and it is the one at the root.** A reader who arrives from npm has nowhere else to
 * look for the history — the number they installed is the only thing they have — so it has to be in
 * the tarball. Two hand-maintained copies is how one of them goes stale, which is the reasoning
 * that already keeps the TextMate grammar generated rather than checked in twice.
 *
 * The copies are gitignored, and `scripts/packages.test.mjs` fails if one is ever committed.
 */
const CHANGELOG = 'CHANGELOG.md';

function build(name) {
  const dir = path.join(ROOT, 'packages', name);
  if (!existsSync(dir)) throw new Error(`no package at packages/${name}`);

  /* A stale `dist/` is worse than none: a file deleted from `src/` stays reachable through the
     `exports` map, and the tarball carries a module nothing in this repository still writes. */
  rmSync(path.join(dir, 'dist'), { recursive: true, force: true });

  execFileSync(TSC, ['-p', path.join(dir, 'tsconfig.build.json')], { cwd: ROOT, stdio: 'inherit' });

  copyFileSync(path.join(ROOT, CHANGELOG), path.join(dir, CHANGELOG));

  for (const [from, to] of ASSETS[name] ?? []) {
    const source = path.join(dir, from);
    if (!existsSync(source)) {
      throw new Error(
        `${name}: ${from} is missing, so ${to} would be absent from the tarball. ` +
          (from.includes('grammar') ? 'Run `npm run grammar`.' : ''),
      );
    }
    copyFileSync(source, path.join(dir, to));
  }

  /*
   * The `bin` entry, made executable and given a shebang if the emit dropped one.
   *
   * npm sets the executable bit itself on install, so this is for the workspace copy — where the
   * bin is a symlink into `dist/` and `npx driftscript-language` has to work before anything is
   * published. The shebang check is a guard rather than a fix: `tsc` preserves one, and a silently
   * missing shebang produces a binary that runs as a shell script and fails on the first `import`.
   */
  const bin = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).bin;
  for (const entry of Object.values(bin ?? {})) {
    const file = path.join(dir, entry);
    const text = readFileSync(file, 'utf8');
    if (!text.startsWith('#!')) writeFileSync(file, `#!/usr/bin/env node\n${text}`);
    chmodSync(file, 0o755);
  }

  process.stdout.write(`built ${name}\n`);
}

/**
 * What this script writes into each package, as data other tools can read.
 *
 * **Exported rather than restated**, because the alternative is a second list that goes stale.
 * `scripts/docs.test.mjs` needs it: the package READMEs link `CHANGELOG.md`, which is a real link
 * for anybody reading the tarball on npm and a dangling one in a checkout that has not been built.
 * A link checker that hard-coded an exception for that filename would be a link checker with a hole
 * in it; one that asks the build what the build writes has none.
 *
 * It fails the day this script stops writing one of them, which is the point.
 */
export function writtenByBuild(name) {
  return [CHANGELOG, ...(ASSETS[name] ?? []).map(([, to]) => to)];
}

/* Only when run, never when imported — so a tool can ask what the build writes without a build
   happening as a side effect of the question. The grammar copy step uses the same guard. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2);
  const targets = requested.length > 0 ? requested : ORDER;
  for (const name of targets) {
    if (!ORDER.includes(name)) {
      throw new Error(`unknown package \`${name}\`; expected one of ${ORDER.join(', ')}`);
    }
  }
  for (const name of ORDER) if (targets.includes(name)) build(name);
}

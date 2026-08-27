/**
 * Every workspace package resolves its siblings through the workspace, not from the registry.
 *
 * **This exists because a stale nested install made every local check of the language server lie.**
 *
 * Measured on 2026-08-28. Cutting 1.6.0 moves `version` in the manifests before the internal range
 * that names it, and in that window `driftscript-language` depended on `driftscript@1.5.0` while the
 * workspace copy had already become `1.6.0` — so npm could not link the sibling and did the
 * reasonable thing instead: it fetched the *published* 1.5.0 into
 * `packages/driftscript-language/node_modules/driftscript`. Fixing the range afterwards did not
 * remove it, because `npm install --package-lock-only` writes a lockfile and not a tree.
 *
 * From then on the language server was built and typechecked against **the previous release of the
 * compiler**. `npm run build`, `npm run typecheck` and the whole suite passed locally while CI —
 * which installs from the lockfile into an empty tree — failed on a declaration kind the local copy
 * had never heard of. The agreement test, whose entire job is that the server and the build are the
 * same code, was comparing the server against a compiler from a different version and could not see
 * it.
 *
 * So the claim is about the *tree* rather than about the manifests, which `version.test.mjs` already
 * holds: a sibling that resolves anywhere but the workspace is a check running against code this
 * repository does not contain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Every directory npm treats as a workspace package. */
function packageDirs() {
  const dirs = [];
  for (const group of ['packages', 'editors']) {
    const base = path.join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (existsSync(path.join(base, name, 'package.json'))) dirs.push(path.join(base, name));
    }
  }
  return dirs;
}

const names = new Set(
  packageDirs()
    .map((dir) => read(path.join(dir, 'package.json')).name)
    .filter((name) => typeof name === 'string'),
);

test('no workspace package is shadowed by a nested copy of a sibling', () => {
  const shadowed = [];
  for (const dir of packageDirs()) {
    const nested = path.join(dir, 'node_modules');
    if (!existsSync(nested)) continue;
    for (const entry of readdirSync(nested)) {
      if (!names.has(entry)) continue;
      const at = path.join(nested, entry);
      /* A symlink here is npm hoisting a sibling into place and is fine; a real directory is a copy
         fetched from the registry, which is the case that lies. */
      if (lstatSync(at).isSymbolicLink()) continue;
      const version = existsSync(path.join(at, 'package.json'))
        ? read(path.join(at, 'package.json')).version
        : 'unknown';
      shadowed.push(
        `${path.relative(ROOT, at)} is a real directory at ${version}, not a link to the workspace`,
      );
    }
  }

  assert.deepEqual(
    shadowed,
    [],
    `a sibling is installed from the registry instead of linked, so anything built against it is ` +
      `checked against code this repository does not contain. Remove it and reinstall:\n  ` +
      `${shadowed.join('\n  ')}`,
  );
});

test('every internal dependency names a package this workspace contains', () => {
  /* The condition that produced the shadow: a range naming a version the workspace no longer
     carries. `version.test.mjs` holds that the numbers agree; this holds that the *name* resolves
     here at all, so a typo in a range fails as a workspace problem rather than as a 404 on CI. */
  const wrong = [];
  for (const dir of packageDirs()) {
    const manifest = read(path.join(dir, 'package.json'));
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (!names.has(name)) continue;
        const sibling = packageDirs()
          .map((d) => read(path.join(d, 'package.json')))
          .find((m) => m.name === name);
        if (sibling !== undefined && sibling.version !== range) {
          wrong.push(`${manifest.name} wants ${name}@${range}; the workspace has ${sibling.version}`);
        }
      }
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

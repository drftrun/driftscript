/**
 * A package may only reach outside itself through a dependency it declares.
 *
 * Two ways a workspace rots, and this catches both. A relative import that climbs out of its own
 * package compiles perfectly here — the files are all on one disk — and breaks the moment somebody
 * installs the package from a registry. And a bare import that is not in `dependencies` resolves
 * through the workspace's hoisted `node_modules` and fails the same way.
 *
 * **This repository is the extraction those guards were written for.** They lived in the engine
 * repository and were the reason the language could be moved at all; they come with it, because
 * the property they hold — that `driftscript` depends on nothing — is now a published claim rather
 * than an internal one. `npm i driftscript` adds one package to a stranger's tree, and this is
 * what fails if that stops being true.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = path.join(ROOT, 'packages');

function sources(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * Nearly every file here explains an import before making it, and several explain an import they
 * deliberately do *not* make — the Vite plugin's comment about why a bundler config cannot import
 * an engine is three paragraphs of exactly the text this test refuses. A sentence about an import
 * is not an import.
 */
function code(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function packages() {
  return readdirSync(PACKAGES)
    .filter((name) => existsSync(path.join(PACKAGES, name, 'package.json')))
    .map((name) => {
      const manifest = JSON.parse(readFileSync(path.join(PACKAGES, name, 'package.json'), 'utf8'));
      return {
        dir: path.join(PACKAGES, name),
        name: manifest.name,
        runtime: new Set([
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.peerDependencies ?? {}),
        ]),
        dev: new Set(Object.keys(manifest.devDependencies ?? {})),
      };
    });
}

/**
 * Every import specifier a file states, and nothing that merely looks like one.
 *
 * **Anchored at column zero, which is a fact about ESM rather than a formatting preference.** An
 * import declaration is only legal at the top level, so every real one starts a line. The compiler
 * emits import statements *as text* — `js.ts` builds a consumer's `import … from './x.drs'` inside
 * a template literal — and a scan that did not anchor would read the emitter's output as this
 * package's own dependencies. So would the regex in `topLevel.test.ts` that parses them back out.
 *
 * `[^;]*?` rather than `[\s\S]*?` so a multi-line import is matched whole and a statement without
 * a `from` cannot swallow the next one.
 */
function specifiers(file) {
  const text = code(file);
  return [
    ...text.matchAll(/^(?:import|export)[^;]*?\bfrom '([^']+)'/gm),
    ...text.matchAll(/^import '([^']+)'/gm),
  ].map(([, target]) => target);
}

test('every relative import stays inside its package and resolves to a file', () => {
  const broken = [];
  for (const pkg of packages()) {
    for (const file of sources(path.join(pkg.dir, 'src'))) {
      for (const target of specifiers(file).filter((t) => t.startsWith('.'))) {
        const resolved = path.resolve(path.dirname(file), target);
        if (!resolved.startsWith(pkg.dir + path.sep)) {
          broken.push(`${path.relative(ROOT, file)} -> ${target} leaves ${pkg.name}`);
          continue;
        }
        /*
         * Existence is checked as well as containment, because the two failures look nothing alike
         * and only one of them is obvious. A module moved out of a package leaves imports like
         * `../render/mesh` behind, and that still resolves *inside* the package by the path test
         * while pointing at nothing at all.
         */
        const exists = ['', '.ts', '/index.ts', '.mjs', '.d.ts'].some((suffix) =>
          existsSync(resolved + suffix),
        );
        if (!exists) {
          broken.push(`${path.relative(ROOT, file)} -> ${target} resolves to nothing`);
        }
      }
    }
  }
  assert.deepEqual(broken, [], broken.join('\n'));
});

/**
 * The dependency tree a stranger installs is the one the manifests describe.
 *
 * **`driftscript` adds one package to a consumer's tree, and that is a claim on a public page.** It
 * is checkable with `npm ls`, which means it is checkable by anyone, which means it has to be true
 * rather than nearly true. A bare import that resolves through this workspace's hoisted
 * `node_modules` looks identical to a declared one from inside the repository — and the failure it
 * causes lands in a stranger's build with a module-not-found for a name they never asked for.
 *
 * Node builtins are allowed and are not dependencies. `vitest` is allowed in a test file, where it
 * is the runner rather than an import.
 */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

test('every bare import is a declared dependency, and runtime code uses no devDependency', () => {
  const undeclared = [];
  for (const pkg of packages()) {
    for (const file of sources(path.join(pkg.dir, 'src'))) {
      const isTest = file.endsWith('.test.ts');
      for (const target of specifiers(file).filter((t) => !t.startsWith('.'))) {
        /* `driftscript/compiler` declares `driftscript`; a subpath is the same dependency. */
        const root = target.startsWith('@') ? target.split('/').slice(0, 2).join('/') : target.split('/')[0];
        if (BUILTINS.has(target) || BUILTINS.has(root)) continue;
        if (root === pkg.name) continue;
        if (pkg.runtime.has(root)) continue;
        if (isTest && (pkg.dev.has(root) || root === 'vitest')) continue;
        undeclared.push(
          pkg.dev.has(root)
            ? `${path.relative(ROOT, file)} imports ${target}, a devDependency of ${pkg.name}, from runtime code`
            : `${path.relative(ROOT, file)} imports ${target}, which ${pkg.name} does not declare`,
        );
      }
    }
  }
  assert.deepEqual(undeclared, [], undeclared.join('\n'));
});

/**
 * The language may not reach the engine it was written for, in either direction of accident.
 *
 * DriftScript is a reusable language and DriftEngine is its first host. The seam is only real if
 * something fails when it is crossed, and two crossings are invisible to review: a
 * `peerDependency` added for one convenient type, and an `import type` that a bundler erases so no
 * generated output ever shows it. Either leaves the package compiling perfectly and unusable by
 * anybody who does not have the engine — which, the engine being closed, is everybody.
 *
 * **Type-only imports are checked exactly like value imports**, because the property being defended
 * is "this package stands alone", not "this package emits no engine code". A type is a dependency
 * on a name, and a name that lives in a private repository does not travel.
 *
 * The cost is that a genuinely shared type must be restated at the boundary rather than imported.
 * What would make this wrong is the engine becoming the only host anyone wants — at which point the
 * guard is ceremony, and that is a decision to take out loud rather than by deleting a test.
 *
 * This is one of three mechanisms on the same claim: `scripts/version.test.mjs` catches the version
 * line, and the `driftscript-runtime-only` fixture in `scripts/size-gate.test.mjs` catches it by
 * failing to bundle with no engine present.
 */
test('no package imports or declares an engine package', () => {
  const offences = [];
  for (const pkg of packages()) {
    const manifest = JSON.parse(readFileSync(path.join(pkg.dir, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        if (dep.startsWith('@driftengine/')) offences.push(`${pkg.name} declares ${dep} in ${field}`);
      }
    }
    for (const file of sources(path.join(pkg.dir, 'src'))) {
      for (const target of specifiers(file)) {
        if (target.startsWith('@driftengine/')) {
          offences.push(`${path.relative(ROOT, file)} imports ${target}`);
        }
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    `the language must stand alone:\n  ${offences.join('\n  ')}`,
  );
});

/**
 * What each entry point costs, measured rather than asserted.
 *
 * esbuild is a devDependency rather than an `npx` fetch, so the gate is deterministic in CI and
 * does not need the network at test time.
 *
 * **It bundles the fixtures through the `exports` map, which means it measures `dist/`.** That is
 * the correction this repository was created around: for as long as the package shipped its
 * TypeScript source, this gate measured a path no consumer could resolve. Run `npm run build`
 * first — the check below says so rather than silently measuring a stale directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ESBUILD = path.join(ROOT, 'node_modules', '.bin', 'esbuild');

if (!existsSync(path.join(ROOT, 'packages', 'driftscript', 'dist', 'index.js'))) {
  throw new Error(
    'packages/driftscript/dist is missing, so this gate would measure nothing a consumer ' +
      'resolves. Run `npm run build` first.',
  );
}

function bundle(fixture) {
  const out = mkdtempSync(path.join(tmpdir(), 'size-'));
  try {
    execFileSync(
      ESBUILD,
      [
        path.join(ROOT, 'scripts', 'fixtures', 'size', `${fixture}.ts`),
        '--bundle',
        '--minify',
        '--format=esm',
        '--platform=browser',
        `--outfile=${path.join(out, 'bundle.js')}`,
      ],
      { cwd: ROOT, stdio: 'pipe' },
    );
    const bytes = readFileSync(path.join(out, 'bundle.js'));
    return { text: bytes.toString('utf8'), gzipped: gzipSync(bytes).byteLength };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * The extraction rehearsal: the language bundles with no engine present.
 *
 * The property under test is not what the runtime costs but whether it *builds alone*. esbuild
 * resolves what the module graph reaches, so an engine import does not fail to bundle — it
 * succeeds, quietly, having pulled half a megabyte in behind it. A ceiling is what makes that
 * visible.
 *
 * **A ceiling rather than a floor, and the reason is that a floor here would be noise.** A floor
 * tight enough to mean anything fails on nearly every commit and trains a reader to raise a number
 * without reading it, which is the habit a size gate depends on nobody having.
 *
 * **What it does not catch, stated because a half-guard that reads as a whole one is worse than
 * none.** esbuild drops what the entry point cannot reach, so a *dead* engine import — a re-export
 * nothing uses — tree-shakes away and this passes. `scripts/boundaries.test.mjs` reads the source
 * text and catches every import, reachable or not, including type-only ones; this catches the
 * consequence, which is foreign code actually reaching a consumer's bundle. Neither subsumes the
 * other.
 */
const NO_ENGINE_CEILING = 64 * 1024;

test('the language runtime bundles with no engine present', () => {
  const { gzipped } = bundle('driftscript-runtime-only');
  assert.ok(
    gzipped < NO_ENGINE_CEILING,
    `driftscript-runtime-only is ${gzipped} bytes gzipped, over the ${NO_ENGINE_CEILING}-byte ` +
      'ceiling. The language has almost certainly acquired a foreign import: esbuild resolves what ' +
      'the graph reaches, so that succeeds rather than failing, and the size is how it shows. ' +
      '`node --test scripts/boundaries.test.mjs` names the file.',
  );
});

test('the compiler entry bundles with no engine present', () => {
  const { gzipped } = bundle('driftscript-compiler');
  assert.ok(
    gzipped < NO_ENGINE_CEILING,
    `driftscript-compiler is ${gzipped} bytes gzipped, over the ${NO_ENGINE_CEILING}-byte ceiling.`,
  );
});

/**
 * The compiler does not ship to a browser, asserted on the bundle's **contents** rather than its
 * size.
 *
 * A size floor answers this indirectly and badly: the runtime and the compiler are both small, so
 * a parser could arrive inside a tolerance and a floor would only notice once it had grown.
 * Diagnostic text is what settles it — a parser that is present has its messages in the bundle,
 * and those survive minification because they are string literals rather than identifiers.
 *
 * **The positive half matters as much as the negative one.** Asserting only that the runtime lacks
 * these strings passes just as well if the strings stop existing anywhere, which is what happens
 * the day somebody rewords a diagnostic. Asserting the compiler *has* them is what keeps the probe
 * honest.
 *
 * This measures reachability rather than source hygiene, and the difference was confirmed rather
 * than assumed: a dead `export … from './compiler/index'` in the runtime barrel does not fail here,
 * because esbuild drops what the entry cannot reach, and that is the right answer — a re-export
 * nothing imports costs a consumer nothing. A runtime function that actually calls the compiler
 * does fail, by 5 KB of diagnostic text.
 */
const PARSER_STRINGS = [
  'expected a declaration',
  'is not a type this module declares',
  'wrapping or saturating arithmetic',
];

test('the runtime bundle carries no compiler, and the compiler bundle does', () => {
  const runtime = bundle('driftscript-runtime-only').text;
  const compiler = bundle('driftscript-compiler').text;

  for (const probe of PARSER_STRINGS) {
    assert.ok(
      compiler.includes(probe),
      `the probe string ${JSON.stringify(probe)} is not in the compiler bundle, so its absence ` +
        'from the runtime proves nothing. Update PARSER_STRINGS to text the compiler still emits.',
    );
    assert.ok(
      !runtime.includes(probe),
      `the runtime bundle contains ${JSON.stringify(probe)}, so it has reached the parser. The ` +
        'exports map is what keeps them apart; something in the runtime barrel now imports from ' +
        'the compiler.',
    );
  }
});

/**
 * The two entry points are not the same thing wearing two names.
 *
 * `exports` splitting them is what lets a bundler drop the compiler, and the split is only worth
 * anything if the compiler is the larger half by an order of magnitude. If the two ever measure
 * alike, either the runtime has grown a front end or the compiler has been hollowed out, and both
 * are worth a stop.
 */
test('the compiler is the heavy half, by the margin the exports split exists for', () => {
  const runtime = bundle('driftscript-runtime-only').gzipped;
  const compiler = bundle('driftscript-compiler').gzipped;
  assert.ok(
    compiler > runtime * 4,
    `the compiler is ${compiler} bytes gzipped and the runtime is ${runtime}. A consumer's ` +
      'production bundle drops the compiler, and that saving is what the second entry point is for.',
  );
});

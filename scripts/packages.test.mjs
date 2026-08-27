/**
 * Every package is described, and nothing generated is committed twice.
 *
 * **Both halves had rotted at once in the repository this came from, and neither failed anything.**
 * The root README's package table named five, listed six, and there were eleven on disk. That is
 * the map a stranger starts at, wrong in the one place being wrong costs the most.
 *
 * The second half is the rule that keeps the first one cheap: a file that exists in two places goes
 * stale in one of them, silently, on the Friday somebody edits the other. So the grammar is
 * generated and copied, the changelog is written into each package by the build, and the client
 * bundle is built — and none of the three is in git.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');

function workspaces() {
  return ['packages', 'editors'].flatMap((group) =>
    readdirSync(path.join(ROOT, group))
      .filter((name) => existsSync(path.join(ROOT, group, name, 'package.json')))
      .map((name) => ({
        dir: `${group}/${name}`,
        full: path.join(ROOT, group, name),
        manifest: JSON.parse(readFileSync(path.join(ROOT, group, name, 'package.json'), 'utf8')),
      })),
  );
}

const rootReadme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

test('every package has a README', () => {
  const missing = workspaces()
    .filter((pkg) => !existsSync(path.join(pkg.full, 'README.md')))
    .map((pkg) => pkg.dir);
  assert.deepEqual(missing, [], `packages with no README:\n  ${missing.join('\n  ')}`);
});

test('a package README opens by naming the package', () => {
  /* A reader arriving from a file tree needs the first line to say which of these they opened.
     Deriving it from the manifest means a rename cannot leave the heading behind. */
  const wrong = [];
  for (const pkg of workspaces()) {
    const heading = readFileSync(path.join(pkg.full, 'README.md'), 'utf8').split('\n')[0].trim();
    const name = pkg.manifest.name.replace(/-vscode$/, '');
    if (!heading.toLowerCase().includes(name.toLowerCase())) {
      wrong.push(`${pkg.dir}: "${heading}" does not name ${pkg.manifest.name}`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('every package carries the licence text, not only the field', () => {
  /* MIT requires the notice to travel with the copy, and the repository root does not travel. */
  const missing = workspaces()
    .filter((pkg) => !existsSync(path.join(pkg.full, 'LICENSE')))
    .map((pkg) => pkg.dir);
  assert.deepEqual(missing, [], `packages with no LICENSE:\n  ${missing.join('\n  ')}`);
});

test('the root README names every package that exists', () => {
  const absent = workspaces().filter((pkg) => !rootReadme.includes(pkg.dir)).map((pkg) => pkg.dir);
  assert.deepEqual(
    absent,
    [],
    `the root README is the map a stranger starts at, and it does not name:\n  ${absent.join('\n  ')}`,
  );
});

/**
 * The three generated artefacts, none of them in git.
 *
 * Each is a copy of something this repository already holds one definition of, and a committed copy
 * is a second definition. The failure mode is always the same and always silent: the copy keeps
 * working, keeps being read, and stops matching.
 */
const GENERATED = [
  ['editors/vscode/syntaxes', 'a committed grammar copy is a second definition of the language'],
  ['editors/vscode/out', 'a committed bundle is a second copy of the client'],
  ['packages/driftscript/CHANGELOG.md', 'the changelog is written by `npm run build` from the one at the root'],
  ['packages/driftscript-language/CHANGELOG.md', 'the changelog is written by `npm run build` from the one at the root'],
  ['packages/driftscript/dist', 'the build output is not source'],
  ['packages/driftscript-language/dist', 'the build output is not source'],
];

for (const [target, why] of GENERATED) {
  test(`${target} is not committed`, () => {
    const tracked = execFileSync('git', ['ls-files', target], { cwd: ROOT, encoding: 'utf8' }).trim();
    assert.equal(tracked, '', `${why}:\n${tracked}`);
  });
}

test('the build writes the changelog into every published package', () => {
  /* It has to be in the tarball: somebody arriving from npm has the version number and nothing
     else. This asserts the build ran, which is also what `prepack` guarantees at publish time. */
  const missing = ['driftscript', 'driftscript-language'].filter(
    (name) => !existsSync(path.join(ROOT, 'packages', name, 'CHANGELOG.md')),
  );
  assert.deepEqual(missing, [], `run \`npm run build\`. Missing changelog in: ${missing.join(', ')}`);
});

/**
 * A README that quotes a size quotes the measured one.
 *
 * **Every README in the repository this came from that quoted a gzipped cost quoted a stale one**,
 * each of them under a sentence saying the number was a fact about the build rather than a claim in
 * a document. Core said 369.8 KB against a measured 524.3. The sentence was right and the number was
 * not, which is the worst combination: a reader who checks finds a project that says the right
 * things and does not do them.
 *
 * **A tolerance rather than an exact match, and the reasoning is the size gate's.** A number this
 * README quotes is an order-of-magnitude claim — "this is a few hundred kilobytes, not a few
 * megabytes" — and asserting it to the byte would fail on every commit that adds a line, training a
 * reader to raise a number without reading it. Three per cent is loose enough to survive ordinary
 * work and tight enough that the failures above would all have fired.
 */
const SIZE_TOLERANCE = 0.03;

test('the size the driftscript README quotes is the size npm would pack', () => {
  const readme = readFileSync(path.join(ROOT, 'packages/driftscript/README.md'), 'utf8');
  const quoted = readme.match(/(\d+(?:\.\d+)?) kB packed/);
  assert.ok(quoted, 'the README no longer quotes a packed size; remove this test or restore the claim');

  /*
   * Both streams, because npm writes the file listing and the totals to **stderr** and only the
   * tarball name to stdout. Reading stdout alone finds no size and reports that the README stopped
   * quoting one, which is a failure message pointing at the wrong file.
   *
   * `--ignore-scripts` skips `prepack`, so this measures the `dist/` already on disk rather than
   * running a build inside a test. The size gate in the same suite already requires that `dist/` to
   * be current.
   */
  const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '-w', 'driftscript'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const notice = `${packed.stdout ?? ''}${packed.stderr ?? ''}`;
  const measured = notice.match(/package size:\s*([\d.]+)\s*kB/);
  assert.ok(measured, `could not read a packed size out of npm pack:\n${notice.slice(-400)}`);

  const stated = Number(quoted[1]);
  const actual = Number(measured[1]);
  const drift = Math.abs(actual - stated) / actual;
  assert.ok(
    drift <= SIZE_TOLERANCE,
    `packages/driftscript/README.md says ${stated} kB packed and npm packs ${actual} kB ` +
      `(${(drift * 100).toFixed(1)}% off). The number is a fact about the build, so move it.`,
  );
});

/**
 * One number, in every place it is written down.
 *
 * **The half that is invisible locally is the ranges.** Every package here is a workspace link, so
 * a `"driftscript": "1.3.0"` left behind after a bump is green through `npm test`, `npm run
 * typecheck` and every build — nothing resolves it. It fails the first time somebody installs
 * `driftscript-language` from the registry, where npm goes and asks for a version that does not
 * exist, and the error names the registry rather than the bump, so it reads as infrastructure.
 *
 * That is not a hypothetical. It happened on the first release that moved this line inside the
 * engine repository, exactly this way.
 *
 * **So count, do not read.** A test that lists the files it checks passes forever after somebody
 * adds a fourth manifest it has never heard of.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

const root = read(path.join(ROOT, 'package.json'));

/**
 * The packages that move together, and the one that does not.
 *
 * `driftscript` and `driftscript-language` are one release, in one order, because
 * `agreement.test.ts` exists to hold the property that the server and the build are the same code
 * — and a server compiled against a different compiler than the build uses is precisely the
 * disagreement it was written to prevent. The exact pin below is what makes that a fact about an
 * install rather than about this checkout.
 *
 * **`driftscript-vscode` carries its own line**, and this is where that decision is written down so
 * it is not mistaken for an oversight. It ships to a different registry, it is not published at all
 * yet, and its version is a claim about the editor client rather than about the language. A shared
 * line would mean a language patch republishing an extension nothing in it changed.
 */
const LOCKSTEP = ['driftscript', 'driftscript-language'];

function manifests() {
  const dirs = [
    path.join(ROOT, 'package.json'),
    ...readdirSync(path.join(ROOT, 'packages')).map((d) => path.join(ROOT, 'packages', d, 'package.json')),
    ...readdirSync(path.join(ROOT, 'editors')).map((d) => path.join(ROOT, 'editors', d, 'package.json')),
  ];
  return dirs.filter(existsSync).map((file) => ({ file: path.relative(ROOT, file), manifest: read(file) }));
}

test('the language packages and the workspace carry one version', () => {
  const wrong = manifests()
    .filter(({ manifest }) => manifest.name === root.name || LOCKSTEP.includes(manifest.name))
    .filter(({ manifest }) => manifest.version !== root.version)
    .map(({ file, manifest }) => `${file} is ${manifest.version}, not ${root.version}`);
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('every package that should be on that line is, and the count is stated', () => {
  /* Three: the workspace root and the two published packages. A fourth appearing without this
     number moving is a package nobody decided the version line for. */
  const onTheLine = manifests().filter(
    ({ manifest }) => manifest.name === root.name || LOCKSTEP.includes(manifest.name),
  );
  assert.equal(
    onTheLine.length,
    3,
    `${onTheLine.length} manifests are on the shared version line and this test expects 3. ` +
      'Adding a package means deciding whether it moves with the language, and saying so here.',
  );
});

test('the editor client is deliberately not on it', () => {
  const extension = manifests().find(({ manifest }) => manifest.name === 'driftscript-vscode');
  assert.ok(extension, 'editors/vscode/package.json is missing');
  assert.notEqual(
    extension.manifest.version,
    root.version,
    'the editor client carries its own line — see the comment above `LOCKSTEP`. If it is being ' +
      'moved onto the shared one, that is a decision, and this test is where it is recorded.',
  );
});

test('every internal range names the version that exists', () => {
  const wrong = [];
  let ranges = 0;
  for (const { file, manifest } of manifests()) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (!LOCKSTEP.includes(dep)) continue;
        ranges += 1;
        if (range !== root.version) wrong.push(`${file} ${field}.${dep} is "${range}", not "${root.version}"`);
      }
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
  /*
   * One: `driftscript-language` → `driftscript`. An exact pin rather than a caret, deliberately;
   * `docs/RELEASING.md` says what that costs.
   *
   * **The extension deliberately declares neither of them, and that is worth a sentence because the
   * obvious design does.** It needs the language server, so making it a dependency and resolving it
   * out of `node_modules` reads as the tidy answer. It does not survive packaging: this workspace
   * resolves that name through a symlink into `packages/`, and `vsce` follows it out of the extension
   * folder and tries to pack the whole repository. The extension bundles the server instead, so it
   * has a build-time relationship and no dependency at all.
   */
  assert.equal(ranges, 1, `${ranges} internal ranges found and this test expects 1`);
});

test('the lockfile records the same version, because that is what a consumer CI reads', () => {
  /* `npm ci` tolerates a stale recorded version for a workspace member right up until it does not,
     and the error it produces then names a missing package rather than the bump that caused it.
     `npm install --package-lock-only` writes this. */
  const lock = read(path.join(ROOT, 'package-lock.json'));
  const wrong = [];
  for (const name of LOCKSTEP) {
    const entry = lock.packages?.[`packages/${name}`];
    assert.ok(entry, `the lockfile has no entry for packages/${name}`);
    if (entry.version !== root.version) {
      wrong.push(`packages/${name} is recorded as ${entry.version}, not ${root.version}`);
    }
  }
  assert.deepEqual(wrong, [], `run \`npm install --package-lock-only\`:\n  ${wrong.join('\n  ')}`);
});

test('the changelog opens on the version being shipped', () => {
  /* A number with no entry is a release nobody described, and a reader who arrives from npm has
     nowhere else to look — the repository is the only history this package has. */
  const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const first = changelog.match(/^## (\S+)/m);
  assert.ok(first, 'CHANGELOG.md has no `## <version>` heading');
  assert.equal(
    first[1],
    root.version,
    `CHANGELOG.md opens on ${first[1]} and the manifests say ${root.version}`,
  );
});

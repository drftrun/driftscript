/**
 * What a published manifest has to say, asserted where it is cheap to assert.
 *
 * `scripts/publish-check.mjs` is the real gate and it needs a clean room, a network and half a
 * minute. These are the rows that need none of that, so they run on every commit instead of before
 * every release — because a manifest field goes missing on an ordinary Tuesday and is noticed on a
 * release day, which is the worst possible day to find it.
 *
 * **Every field here was absent when the language was first considered publishable**, and the list
 * is the one that review before the first publish produced, rather than a list of everything npm
 * accepts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLISHED = ['driftscript', 'driftscript-language'];

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const manifestOf = (name) => read(path.join(ROOT, 'packages', name, 'package.json'));

/**
 * The fields, and what each is for.
 *
 * `repository` is what npm links "Repository" from and what provenance attestation reads.
 * `bugs` is the address a defect report goes to, and a published MIT package that names none is a
 * package inviting patches with nowhere to send them. `keywords` is the only discovery surface npm
 * has. `engines` records the Node floor, which this package genuinely has.
 */
const REQUIRED = ['description', 'license', 'author', 'homepage', 'repository', 'bugs', 'keywords', 'engines', 'files', 'exports'];

for (const name of PUBLISHED) {
  const dir = path.join(ROOT, 'packages', name);
  const manifest = manifestOf(name);

  test(`${name}: every field a published manifest needs is present`, () => {
    const missing = REQUIRED.filter((field) => manifest[field] === undefined);
    assert.deepEqual(missing, [], `${name} is missing: ${missing.join(', ')}`);
  });

  test(`${name}: it is publishable at all`, () => {
    /* `"private": true` is the correct default for a workspace member and npm refuses to publish
       one. Removing it is a deliberate step, so this is where it is recorded as taken. */
    assert.notEqual(manifest.private, true, `${name} is marked private and npm would refuse it`);
  });

  test(`${name}: the repository field names this repository and this directory`, () => {
    assert.equal(manifest.repository.url, 'git+https://github.com/drftrun/driftscript.git');
    assert.equal(manifest.repository.directory, `packages/${name}`);
  });

  test(`${name}: the licence file is beside the manifest, not only named by it`, () => {
    /* MIT's own conditions require the notice to travel with the copy. A field is not the notice,
       and the repository root is not published. */
    assert.ok(existsSync(path.join(dir, 'LICENSE')), `packages/${name}/LICENSE is missing`);
    assert.equal(manifest.license, 'MIT');
  });

  test(`${name}: the files whitelist keeps tests out and is a whitelist`, () => {
    /* A whitelist rather than an `.npmignore`, because a whitelist fails closed when a directory is
       added. Forty-four test files once shipped to every consumer — 35.5% of the unpacked size —
       because neither manifest declared this field at all. */
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
    assert.ok(
      manifest.files.some((pattern) => pattern === '!src/**/*.test.ts'),
      'src ships for source maps, so the tests inside it have to be excluded by name',
    );
  });

  test(`${name}: every exports target exists after a build`, () => {
    /* An `exports` map is the only door into the package, and a target that resolves to nothing is
       a `ERR_PACKAGE_PATH_NOT_EXPORTED` in a stranger's build rather than here. */
    const missing = [];
    for (const [entry, target] of Object.entries(manifest.exports)) {
      for (const file of typeof target === 'string' ? [target] : Object.values(target)) {
        if (!existsSync(path.join(dir, file))) missing.push(`${entry} -> ${file}`);
      }
    }
    assert.deepEqual(missing, [], `run \`npm run build\`. Missing:\n  ${missing.join('\n  ')}`);
  });

  test(`${name}: package.json is reachable, because tooling reads it`, () => {
    /* A strict `exports` map denies it otherwise, and several tools ask for it by path. */
    assert.equal(manifest.exports['./package.json'], './package.json');
  });

  test(`${name}: the README says how to install it before it says anything else`, () => {
    /* It opened on a Vite config, which is the second thing a reader needs. `grep -c "npm i"`
       returned 0 on both READMEs at the point they were first considered publishable. */
    const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
    const install = readme.indexOf('npm i ');
    assert.ok(install > 0, `${name}'s README never says how to install it`);
    assert.ok(
      install < readme.length / 3,
      'the install line is past the first third of the README, which is not where a reader looks',
    );
  });

  test(`${name}: no relative link escapes the package`, () => {
    /*
     * On npmjs.com a relative link resolves against the package, so a link that climbs out of it is
     * a 404 on the page most readers judge the package from. Four of them shipped: one to a private
     * document, three to files in a repository nobody could open.
     */
    const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
    const escaping = [];
    for (const [, , target] of readme.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const resolved = path.resolve(dir, target.split('#')[0]);
      if (!resolved.startsWith(dir + path.sep)) escaping.push(`${target} leaves the package`);
      else if (!existsSync(resolved)) escaping.push(`${target} resolves to nothing`);
    }
    assert.deepEqual(escaping, [], `${name}/README.md:\n  ${escaping.join('\n  ')}`);
  });
}

test('driftscript adds one package to a consumer’s tree', () => {
  /*
   * The headline claim, and it is checkable by anyone with `npm ls`, which is what makes it worth
   * asserting rather than writing down. `source-map-js` is a devDependency used only by tests.
   */
  const manifest = manifestOf('driftscript');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), []);
});

test('every package directory is either published or says why not', () => {
  /* A new package that is neither listed above nor marked private is one nobody decided about, and
     the decision is easiest to take on the day it is created. */
  const undecided = readdirSync(path.join(ROOT, 'packages'))
    .filter((name) => existsSync(path.join(ROOT, 'packages', name, 'package.json')))
    .filter((name) => !PUBLISHED.includes(name))
    .filter((name) => manifestOf(name).private !== true);
  assert.deepEqual(undecided, [], `packages neither published nor private: ${undecided.join(', ')}`);
});

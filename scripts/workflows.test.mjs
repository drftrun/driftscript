/**
 * The release runs the same gates as CI, in the same order.
 *
 * **This exists because the two had already drifted and nothing could see it.** `release.yml` was
 * `workflow_dispatch` only for as long as it existed, so it had never once been run — and it was
 * missing `npm run extension` and `npm run grammar:check`, both of which `ci.yml` had. The editors
 * gate measures a packed `.vsix` rather than the source, so on a clean checkout it failed with *run
 * `npm run extension` first*. The first automated release would have died on it.
 *
 * A green CI on every commit said nothing about this, because CI was not the workflow with the
 * hole in it. That is the shape `AGENTS.md` means: a claim that can drift, asserted nowhere that
 * fails.
 *
 * **The claim is a comparison rather than a list**, deliberately. A test naming the seven commands
 * would pass forever after somebody adds an eighth to `ci.yml` and forgets `release.yml`, which is
 * the exact failure it is here to prevent. Comparing the two means a step added to either is a step
 * that must be added to both, and the diff says which one is behind.
 *
 * **They are not equal, and the one difference is the point of the release.** `publish:check` packs
 * a tarball and installs it in a clean room, which needs the network — so `AGENTS.md` files it as a
 * release gate and not a commit gate, and CI must not grow it. The claim is therefore that CI's
 * gates are a *prefix* of the release's, and that the only thing after them is that one.
 *
 * Parsed with a regular expression rather than a YAML library, because adding a dependency to the
 * toolchain is a supply-chain cost and this needs one line shape. A gate step is written
 * `      - run: <command>`; a conditional publish step hangs off a `name:` and is indented deeper,
 * so it is not matched and does not need to be excluded by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const gatesOf = (workflow) =>
  readFileSync(path.join(ROOT, '.github/workflows', workflow), 'utf8')
    .split('\n')
    .map((line) => /^ {6}- run: (.+)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1].trim());

test('the release runs every gate CI runs, in the same order, then the clean room', () => {
  const ci = gatesOf('ci.yml');
  const release = gatesOf('release.yml');

  /* A sanity floor. A regex that matched nothing would make the comparison below trivially true
     and this file a test of its own parser. */
  assert.ok(ci.length >= 5, `read only ${ci.length} steps out of ci.yml; the step shape changed`);

  assert.deepEqual(
    release.slice(0, ci.length),
    ci,
    'ci.yml and release.yml no longer run the same gates.\n' +
      `  ci.yml:      ${ci.join(' → ')}\n` +
      `  release.yml: ${release.join(' → ')}`,
  );

  /* Exactly one step beyond CI's, and it is the one that needs the network. Asserted rather than
     merely allowed, so that a step quietly appended to the release — where nobody runs it until a
     release day — is a failure here instead of a surprise then. */
  assert.deepEqual(release.slice(ci.length), ['npm run publish:check']);
});

test('the release publishes both packages, in the order the pin requires', () => {
  /* `driftscript-language` pins `driftscript` exactly, so publishing it first lists a package whose
     dependency does not exist. npm accepts that and a consumer's install does not, which makes the
     order a property worth holding rather than a convention worth writing down. */
  const source = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const published = [...source.matchAll(/run: npm publish -w (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(published, ['driftscript', 'driftscript-language']);
});

test('the release cannot publish a version that is already on the registry', () => {
  /* The idempotence that replaced the manual `confirm=publish` gate. If the `decide` job stops
     consulting the registry, a re-run or a revert becomes able to attempt a second release, and
     the only sign would be a failed publish on a day nobody expected one. */
  const source = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  assert.match(source, /npm view "\$pkg@\$VERSION" version/, 'the decide job no longer asks npm what exists');
  for (const step of ['driftscript', 'language']) {
    assert.match(
      source,
      new RegExp(`needs\\.decide\\.outputs\\.${step} == 'yes'`),
      `the ${step} publish step is no longer guarded by what the registry already has`,
    );
  }
});

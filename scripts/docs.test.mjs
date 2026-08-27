/**
 * Every link in every document resolves, and every command a document names exists.
 *
 * **A link checker written before the move rather than after it**, because the move is exactly the
 * event that breaks links: four of them shipped in package READMEs pointing at files in a
 * repository nobody outside could open, and one at a document that was deliberately private.
 *
 * The second half catches the drift a link checker cannot see. A README that says `npm run
 * capabilities` when no such script exists is a reader following an instruction into an error, and
 * the failure is theirs to debug rather than ours to notice.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writtenByBuild } from './build.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Files the build writes into a package, which a checkout may legitimately not have.
 *
 * The package READMEs link `CHANGELOG.md`, and that link is correct: it is what somebody reading
 * the tarball on npm follows, and the build puts the file there. In an unbuilt checkout it points
 * at nothing, which is why this test used to need a build to pass — and a link checker that needs a
 * compiler is one that gets skipped on the change most likely to break a link.
 *
 * **Asked of the build rather than listed here.** A second list is how one of them goes stale.
 */
const BUILD_WRITES = new Set(
  ['driftscript', 'driftscript-language'].flatMap((name) =>
    writtenByBuild(name).map((file) => path.join(ROOT, 'packages', name, file)),
  ),
);

/** Everything committed, skipping what npm and the build write. */
const SKIP = new Set(['node_modules', 'dist', '.git', '.claude', 'out', 'syntaxes']);

function documents(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) documents(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * A document with its fenced code stripped.
 *
 * Several of these show a Markdown link as an *example* of one, and a shell block can contain a
 * bracket followed by a parenthesis for reasons that have nothing to do with linking. A link inside
 * a fence is not a link.
 */
function prose(file) {
  return readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
}

test('every relative link resolves to something that exists', () => {
  const broken = [];
  for (const file of documents()) {
    for (const [, , target] of prose(file).matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target.split('#')[0]);
      if (!existsSync(resolved) && !BUILD_WRITES.has(resolved)) {
        broken.push(`${path.relative(ROOT, file)} -> ${target}`);
      }
    }
  }
  assert.deepEqual(broken, [], `links pointing at nothing:\n  ${broken.join('\n  ')}`);
});

test('no document links into the repository the language came from', () => {
  /*
   * The language was extracted from a private repository, and a relative path into one of its
   * packages resolved perfectly for as long as this code lived beside it. Here it resolves to nothing — which the
   * test above catches — but a *deep GitHub URL* into it would not, and would be a 404 with an
   * explanation nobody outside can read.
   */
  const offences = [];
  for (const file of documents()) {
    const text = readFileSync(file, 'utf8');
    for (const [, url] of text.matchAll(/(https:\/\/github\.com\/drftrun\/(?!driftscript)[^\s)]+)/g)) {
      offences.push(`${path.relative(ROOT, file)} -> ${url}`);
    }
  }
  assert.deepEqual(offences, [], `links into a private repository:\n  ${offences.join('\n  ')}`);
});

test('every `npm run` a document names is a script that exists', () => {
  const scripts = new Set(
    Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts),
  );
  /* The extension is its own workspace with its own scripts, and its README runs them from inside
     its own directory. */
  const extension = new Set(
    Object.keys(
      JSON.parse(readFileSync(path.join(ROOT, 'editors/vscode/package.json'), 'utf8')).scripts,
    ),
  );

  const missing = [];
  for (const file of documents()) {
    const inExtension = file.includes(`${path.sep}editors${path.sep}`);
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/`?npm run ([a-z][a-z:-]*)/g)) {
      if (scripts.has(name)) continue;
      if (inExtension && extension.has(name)) continue;
      missing.push(`${path.relative(ROOT, file)} names \`npm run ${name}\``);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `documents naming a script that does not exist:\n  ${missing.join('\n  ')}`,
  );
});

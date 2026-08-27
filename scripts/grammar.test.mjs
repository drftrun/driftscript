/**
 * The DriftScript grammar agrees with the compiler's token table.
 *
 * A grammar that has drifted still highlights — it just highlights the wrong things — so nothing
 * fails and nobody notices until somebody reads a keyword rendered as a variable and doubts their
 * own file. That silence is the whole reason this is generated rather than reviewed, and this is
 * what makes forgetting to regenerate a failure instead of a slow rot.
 *
 * **Two halves, and the second is the one that is easy to leave out.** Staleness is checked by
 * regenerating and comparing, which catches a keyword added to `tokens.ts` and not carried over.
 * The patterns are then checked against real tokens, which catches the case staleness cannot: a
 * generator that is faithfully producing a rule that does not match anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GRAMMAR_DIR = path.join(ROOT, 'packages/driftscript/src/tooling/grammar');
const GENERATOR = path.join(GRAMMAR_DIR, 'generate.mjs');
const GENERATED = path.join(GRAMMAR_DIR, 'generated', 'driftscript.tmLanguage.json');

const grammar = () => JSON.parse(readFileSync(GENERATED, 'utf8'));

test('the generated grammar is not stale', () => {
  const result = execFileSync('node', [GENERATOR, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.match(result, /ok:/);
});

test('the generated file says not to edit it, in the first thing a reader sees', () => {
  const text = readFileSync(GENERATED, 'utf8');
  const first = JSON.parse(text);
  assert.match(first.$comment, /GENERATED/);
  assert.match(first.$comment, /Never hand-edit/);
  /* The warning is the first key, so it is on screen before the content a reader came to change. */
  assert.equal(Object.keys(first)[0], '$comment');
});

/**
 * Every rule matches what it claims to.
 *
 * A stale-file check compares the generator against its own output and passes happily when both
 * are wrong. These are the fixtures that say the output means something.
 */
const CASES = [
  ['keyword', 'fn', true],
  ['keyword', 'match', true],
  ['keyword', 'return', true],
  ['keyword', 'f32', false],
  ['keyword', 'function', false],
  ['type', 'f32', true],
  ['type', 'u8', true],
  ['type', 'String', true],
  ['type', 'fn', false],
  ['type', 'f32x', false],
  ['annotation', '@deterministic', true],
  ['annotation', '@hot', true],
  ['annotation', '@nonsense', false],
  ['operator', '+=', true],
  ['operator', '+%', true],
  ['operator', '||', true],
  ['keyword', 'component', true],
  ['keyword', 'query', true],
  ['keyword', 'prefab', true],
];

for (const [rule, text, shouldMatch] of CASES) {
  test(`${rule} ${shouldMatch ? 'matches' : 'does not match'} ${JSON.stringify(text)}`, () => {
    const pattern = grammar().repository[rule].match;
    assert.ok(pattern !== undefined, `${rule} has no match pattern`);
    const matched = new RegExp(pattern).test(text);
    assert.equal(
      matched,
      shouldMatch,
      `/${pattern}/ ${matched ? 'matched' : 'did not match'} ${JSON.stringify(text)}`,
    );
  });
}

test('a number with a unit scopes the value and the unit separately', () => {
  const [withUnit] = grammar().repository.number.patterns;
  const match = new RegExp(withUnit.match).exec('250ms');
  assert.ok(match, 'the unit pattern did not match `250ms`');
  assert.equal(match[1], '250');
  assert.equal(match[2], 'ms');
  assert.equal(withUnit.captures['2'].name, 'constant.numeric.unit.driftscript');
});

test('a declaration scopes the name that follows the keyword', () => {
  const [base, type, fn] = grammar().repository.declaration.patterns;
  assert.deepEqual(new RegExp(type.match).exec('data Door')?.slice(1), ['data', 'Door']);
  assert.deepEqual(new RegExp(fn.match).exec('fn swing')?.slice(1), ['fn', 'swing']);
  assert.equal(type.captures['2'].name, 'entity.name.type.driftscript');
  assert.equal(base.captures['4'].name, 'entity.name.type.driftscript');
});

test('the entity-form heads scope their names, and the host clause is matched before the plain form', () => {
  /*
   * Same argument as the base clause below, one declaration along. With the plain `component` rule
   * first, `component Transform from host` highlights the component and leaves `from host` looking
   * like two ordinary words — which is the part of that line saying the declaration creates
   * nothing and only asserts a shape.
   */
  const patterns = grammar().repository.declaration.patterns;
  const host = patterns.find((p) => p.match.includes('from'));
  const plain = patterns.find((p) => p.match.includes('component|entity|prefab'));
  const system = patterns.find((p) => p.match.startsWith('\\b(system)'));

  assert.ok(patterns.indexOf(host) < patterns.indexOf(plain), 'the host clause must be matched first');
  assert.deepEqual(
    new RegExp(host.match).exec('component Transform from host')?.slice(1),
    ['component', 'Transform', 'from', 'host'],
  );
  assert.deepEqual(new RegExp(plain.match).exec('entity Animal')?.slice(1), ['entity', 'Animal']);
  assert.deepEqual(new RegExp(system.match).exec('system Feeder')?.slice(1), ['system', 'Feeder']);
  assert.equal(plain.captures['2'].name, 'entity.name.type.driftscript');
  /* A system is named like a function: it is a body that runs, and the schedule addresses it. */
  assert.equal(system.captures['2'].name, 'entity.name.function.driftscript');
  /* A plain `component X {` must not match the host rule, or the next one never runs for it. */
  assert.equal(new RegExp(host.match).exec('component Health {'), null);
});

test('a base clause scopes the base as a type, and is matched before the plain form', () => {
  /*
   * TextMate takes the first pattern that matches, so order is the whole of this. With the plain
   * `data` rule first, `data Wolf : Dog` highlights the record and leaves its base looking like an
   * ordinary word — which is the one part of that line a reader is looking for.
   */
  const [base] = grammar().repository.declaration.patterns;
  assert.deepEqual(
    new RegExp(base.match).exec('data Wolf : Dog')?.slice(1),
    ['data', 'Wolf', ':', 'Dog'],
  );
  assert.deepEqual(new RegExp(base.match).exec('data Wolf:Dog')?.slice(1), ['data', 'Wolf', ':', 'Dog']);
  /* A record with no base must not match this pattern, or the next one never runs for it. */
  assert.equal(new RegExp(base.match).exec('data Dog {'), null);
});

/**
 * Adding a keyword without regenerating fails.
 *
 * Written as a real perturbation rather than trusted, because a check that has never been red is a
 * check nobody has watched work. The token table is restored in a `finally`, so a failure here does
 * not leave the tree edited.
 */
test('a keyword added to the token table without regenerating is caught', () => {
  const tokens = path.join(ROOT, 'packages/driftscript/src/compiler/tokens.ts');
  const original = readFileSync(tokens, 'utf8');
  try {
    writeFileSync(tokens, original.replace("  'let',", "  'let',\n  'unless',"));
    assert.throws(
      () => execFileSync('node', [GENERATOR, '--check'], { cwd: ROOT, stdio: 'pipe' }),
      /Command failed/,
    );
  } finally {
    writeFileSync(tokens, original);
  }
  /* And green again once restored, so the perturbation is known to have been the cause. */
  const result = execFileSync('node', [GENERATOR, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.match(result, /ok:/);
});

/**
 * Every declaration head in every shipped `.drs` is highlighted by some rule.
 *
 * **The gap this closes was found by a person reading a file, not by a test.** The language grew a
 * base clause — `data Wolf : Dog` — and the grammar kept matching only the plain form, so the base
 * rendered as an ordinary word. `grammar:check` stayed green throughout, because it asserts the
 * generated *token sets* match the compiler's table and the declaration patterns are hand-authored
 * in the skeleton, where nothing was watching.
 *
 * This is not a tokeniser and does not try to be. It answers one question — is there a rule that
 * matches this head, capturing all of it — which is exactly the question that went unasked.
 *
 * **The keyword list here is the second thing to move when the language grows a declaration.** It
 * said `data|enum|fn|task|state` while the entity forms were being added, which would have left
 * every `component`, `entity`, `system` and `prefab` head in every corpus file unexamined — a test
 * that reads more files than before and checks fewer of the lines in them.
 */
function declarationHeads() {
  const roots = ['docs/corpus', 'packages/driftscript/examples', 'demo'];
  const heads = [];
  for (const root of roots) {
    const dir = path.join(ROOT, root);
    for (const name of readdirSync(dir, { recursive: true })) {
      if (!String(name).endsWith('.drs')) continue;
      const file = path.join(root, String(name));
      for (const line of readFileSync(path.join(dir, String(name)), 'utf8').split('\n')) {
        if (/^(data|enum|fn|task|state|component|entity|system|prefab)\s/.test(line)) {
          heads.push({ file, line: line.trim() });
        }
      }
    }
  }
  return heads;
}

test('every declaration head a shipped .drs writes is matched by a grammar rule', () => {
  const patterns = grammar().repository.declaration.patterns.map((p) => new RegExp(p.match));
  const heads = declarationHeads();
  assert.ok(heads.length > 10, `expected declaration heads to read; found ${heads.length}`);

  const unmatched = [];
  for (const { file, line } of heads) {
    /* The head is everything before the opening brace or the parameter list — the part a
       declaration rule is responsible for. */
    const head = line.split(/[{(]/)[0].trim();
    const matched = patterns.some((pattern) => {
      const found = pattern.exec(head);
      return found !== null && found[0].trim() === head;
    });
    if (!matched) unmatched.push(`${file}: ${line}`);
  }

  assert.deepEqual(
    unmatched,
    [],
    `declaration heads no grammar rule matches in full:\n  ${unmatched.join('\n  ')}`,
  );
});

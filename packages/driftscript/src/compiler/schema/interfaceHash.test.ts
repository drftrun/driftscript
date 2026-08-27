import { describe, expect, it } from 'vitest';
import { interfaceHash } from './interfaceHash.ts';
import { parse } from '../parser.ts';
import { check } from '../check/checker.ts';
import { lower } from '../ir/lower.ts';

/** The hash of a source, through the real pipeline rather than a hand-built IR. */
const hashOf = (source: string, dependencies: readonly string[] = []): string => {
  const parsed = parse(source, 'm.drs');
  expect(parsed.diagnostics).toEqual([]);
  const checked = check(parsed.module, 'm.drs');
  expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return interfaceHash(lower(parsed.module, checked), dependencies);
};

const BASE =
  'data Pulse {\n    phase: f32 = 0\n}\n\n' +
  'enum Mode {\n    Fast\n    Slow\n}\n\n' +
  'fn advance(state: mut Pulse, dt: f32) -> f32 {\n    state.phase += dt\n    return state.phase\n}\n';

describe('the interface hash', () => {
  it('does not move when only a body changes', () => {
    const other =
      'data Pulse {\n    phase: f32 = 0\n}\n\n' +
      'enum Mode {\n    Fast\n    Slow\n}\n\n' +
      'fn advance(state: mut Pulse, dt: f32) -> f32 {\n    state.phase += dt\n    state.phase += dt\n    return state.phase\n}\n';

    expect(hashOf(other)).toBe(hashOf(BASE));
  });

  it('does not move for a comment or for whitespace', () => {
    expect(hashOf(`// a note\n\n${BASE}`)).toBe(hashOf(BASE));
    expect(hashOf(BASE.replace('dt: f32', 'dt:  f32'))).toBe(hashOf(BASE));
  });

  it('moves when a parameter type changes', () => {
    const f32 = 'fn scale(by: f32) -> f32 {\n    return by\n}\n';
    const f64 = 'fn scale(by: f64) -> f64 {\n    return by\n}\n';
    expect(hashOf(f64)).not.toBe(hashOf(f32));
  });

  it('moves when only the return type changes', () => {
    /*
     * A dependent compiled against the old one is compiled against a type that is no longer there —
     * the same failure a parameter change causes, one column to the right. The parameters are
     * identical here on purpose: a hash that only reads them cannot tell these two apart.
     */
    const returnsFloat = 'fn measure(at: f32) -> f32 {\n    return at\n}\n';
    const returnsInt = 'fn measure(at: f32) -> i32 {\n    return 1\n}\n';
    expect(hashOf(returnsInt)).not.toBe(hashOf(returnsFloat));
  });

  it('moves when a function stops returning anything', () => {
    const returns = 'fn measure(at: f32) -> f32 {\n    return at\n}\n';
    const voided = 'fn measure(at: f32) {\n}\n';
    expect(hashOf(voided)).not.toBe(hashOf(returns));
  });

  it('moves when a record gains a field', () => {
    expect(hashOf(BASE.replace('phase: f32 = 0', 'phase: f32 = 0\n    depth: f32 = 1'))).not.toBe(
      hashOf(BASE),
    );
  });

  it('moves when a default changes, because a subtype inlines one', () => {
    expect(hashOf(BASE.replace('phase: f32 = 0', 'phase: f32 = 2'))).not.toBe(hashOf(BASE));
  });

  it('moves when an enum gains a variant', () => {
    /* An enum is importable, so a dependent matching on it has an exhaustiveness check that a new
       variant invalidates. A hash that ignored it would leave that dependent compiled against a
       set of variants that is no longer the set. */
    const two = 'enum Mode {\n    Fast\n    Slow\n}\n';
    const three = 'enum Mode {\n    Fast\n    Slow\n    Stopped\n}\n';
    expect(hashOf(three)).not.toBe(hashOf(two));
  });

  it('moves when an enum variant is renamed', () => {
    const slow = 'enum Mode {\n    Fast\n    Slow\n}\n';
    const sluggish = 'enum Mode {\n    Fast\n    Sluggish\n}\n';
    expect(hashOf(sluggish)).not.toBe(hashOf(slow));
  });

  it('moves when a variant gains a payload', () => {
    const bare = 'enum Result {\n    Ready\n}\n';
    const carrying = 'enum Result {\n    Ready(f32)\n}\n';
    expect(hashOf(carrying)).not.toBe(hashOf(bare));
  });

  it('does not move when declarations are reordered', () => {
    const reordered =
      'enum Mode {\n    Fast\n    Slow\n}\n\n' +
      'fn advance(state: mut Pulse, dt: f32) -> f32 {\n    state.phase += dt\n    return state.phase\n}\n\n' +
      'data Pulse {\n    phase: f32 = 0\n}\n';

    expect(hashOf(reordered)).toBe(hashOf(BASE));
  });

  it('moves when the names this module uses from another do', () => {
    expect(hashOf(BASE, ['Wave:phase'])).not.toBe(hashOf(BASE, ['Wave:rate']));
    expect(hashOf(BASE, ['Wave:phase'])).not.toBe(hashOf(BASE));
  });

  it('does not move when the used names are listed in a different order', () => {
    expect(hashOf(BASE, ['a', 'b'])).toBe(hashOf(BASE, ['b', 'a']));
  });
});

describe('an option names its inner type', () => {
  /*
   * **This was a live defect, found while adding an option column to the entity model.** `typeKey`
   * returned `type.kind`, so every option keyed as `option` whatever it held — and the interface
   * hash covers function parameters and return types, where shipped scripts do use options. A
   * module changing `fn f(v: f32?)` to `fn f(v: String?)` produced the *same* hash, so a dependent
   * would not have recompiled against an interface that had genuinely changed.
   *
   * `schema.ts` carried a second, identical private copy of the same function while its own comment
   * said it was "the same function the interface hash uses". Two descriptions of one decision, and
   * they agreed only because neither had moved.
   */
  it('moves the hash when an optional parameter changes what it holds', () => {
    const asFloat = 'fn read(value: f32?) -> bool {\n    return true\n}\n';
    const asString = 'fn read(value: String?) -> bool {\n    return true\n}\n';
    expect(hashOf(asString)).not.toBe(hashOf(asFloat));
  });

  it('moves the hash when an optional return type changes what it holds', () => {
    /* A passthrough, so the bodies are the same shape and only the declared types differ. A literal
       is not assignable to an option here, which is the language working rather than a limitation. */
    const asFloat = 'fn first(v: f32?) -> f32? {\n    return v\n}\n';
    const asString = 'fn first(v: String?) -> String? {\n    return v\n}\n';
    expect(hashOf(asString)).not.toBe(hashOf(asFloat));
  });

  it('still separates an option from the type it wraps', () => {
    const bare = 'fn read(value: f32) -> bool {\n    return true\n}\n';
    const wrapped = 'fn read(value: f32?) -> bool {\n    return true\n}\n';
    expect(hashOf(wrapped)).not.toBe(hashOf(bare));
  });
});

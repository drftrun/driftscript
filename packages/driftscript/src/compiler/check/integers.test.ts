/**
 * What each integer type can hold, asserted against arithmetic rather than against JavaScript.
 *
 * **The expected values here are worked out on paper.** A test that compared against what a
 * JavaScript `number` does would agree with the bug it exists to catch: `2 ** 64 - 1` evaluates to
 * `18446744073709551616`, which is `2^64`, so the old range check let every `u64` overflow through
 * and the arithmetic that followed was quietly inexact.
 *
 * The rows that matter are the ones straddling `2^53`, which is where a double stops holding every
 * integer. Below it the language's promise — explicit overflow behaviour, no undefined results —
 * is deliverable. Above it, it is not, and `integerDomain` is where that is written down.
 */
import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';
import { INTEGER_RANGE, integerDomain, wrapsExactly } from './types.ts';

const compile = (source: string) =>
  compileDriftScript(source, { filename: 'n.drs', host: singleFileHost(), mode: 'development' });

const codes = (source: string): string[] => compile(source).diagnostics.map((d) => d.code);

/** Load the emitted module and hand back its exports, so arithmetic is asserted by running it. */
const run = async (source: string): Promise<Record<string, unknown>> => {
  const { code, diagnostics } = compile(source);
  expect(diagnostics).toEqual([]);
  return (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${btoa(code)}`
  )) as Record<string, unknown>;
};

describe('the domain each integer type actually has', () => {
  it.each([
    ['i8', -128, 127, true],
    ['u8', 0, 255, true],
    ['i16', -32768, 32767, true],
    ['u16', 0, 65535, true],
    ['i32', -2147483648, 2147483647, true],
    ['u32', 0, 4294967295, true],
    /*
     * The two rows this release is about. A `u64` nominally holds `0 … 2^64 - 1`; a double holds
     * every integer only to `2^53 - 1`, and the compiler now says so rather than computing a bound
     * that is itself unrepresentable.
     */
    ['i64', -(2 ** 53 - 1), 2 ** 53 - 1, false],
    ['u64', 0, 2 ** 53 - 1, false],
  ])('%s runs %d to %d', (name, lo, hi, exact) => {
    expect(integerDomain(name)).toEqual({ lo, hi, exact });
  });

  it('gives every declared integer type a domain', () => {
    /* From the table rather than from a list here, so a width added later is covered by this. */
    for (const name of Object.keys(INTEGER_RANGE)) {
      const domain = integerDomain(name);
      expect(domain.hi).toBeGreaterThan(0);
      expect(Number.isSafeInteger(domain.hi)).toBe(true);
      expect(Number.isSafeInteger(domain.lo)).toBe(true);
    }
  });

  it('keeps the 64-bit domain symmetric, so negation cannot leave it', () => {
    const { lo, hi } = integerDomain('i64');
    expect(lo).toBe(-hi);
  });
});

describe('a literal is refused when its type cannot hold it', () => {
  /* Nothing checked this at any width before: `let n: u8 = 300` compiled, and 300 went into a
     `Uint8Array` column as 44. */
  it.each([
    ['u8', '300'],
    ['u8', '-1'],
    ['i8', '128'],
    ['i32', '2147483648'],
    ['u32', '4294967296'],
  ])('refuses %s = %s', (type, value) => {
    expect(codes(`fn f() {\n    let n: ${type} = ${value}\n}\n`)).toContain('DS0222');
  });

  it.each([
    ['u8', '255'],
    ['i8', '-128'],
    ['i32', '2147483647'],
    ['u32', '4294967295'],
    ['u64', '9007199254740991'],
    ['i64', '-9007199254740991'],
  ])('accepts %s = %s', (type, value) => {
    expect(codes(`fn f() {\n    let n: ${type} = ${value}\n}\n`)).toEqual([]);
  });

  it('refuses a `u64` past the safe-integer boundary, and says why the type is not the problem', () => {
    /* `9007199254740993` is 2^53 + 1. It is not representable at all — the nearest doubles are
       2^53 and 2^53 + 2 — so a range check against 2^64 would have accepted a number the program
       could never hold. */
    const { diagnostics } = compile('fn f() {\n    let n: u64 = 9007199254740993\n}\n');
    expect(diagnostics.map((d) => d.code)).toContain('DS0222');
    expect(diagnostics[0].message).toContain('double');
  });

  it('refuses a fractional literal where an integer is wanted', () => {
    expect(codes('fn f() {\n    let n: u8 = 1.5\n}\n')).toContain('DS0222');
  });
});

describe('wrapping is refused where it cannot be exact, and only there', () => {
  it.each(['i64', 'u64'])('refuses `+%%` on %s', (type) => {
    expect(codes(`fn f(a: ${type}, b: ${type}) -> ${type} {\n    return a +% b\n}\n`)).toContain(
      'DS0221',
    );
  });

  it.each(['i64', 'u64'])('refuses `%s.wrap`', (type) => {
    expect(codes(`fn f(v: f64) -> ${type} {\n    return ${type}.wrap(v)\n}\n`)).toContain('DS0221');
  });

  it.each(['i8', 'u8', 'i16', 'u16', 'i32', 'u32'])('still wraps %s', (type) => {
    expect(codes(`fn f(a: ${type}, b: ${type}) -> ${type} {\n    return a +% b\n}\n`)).toEqual([]);
    expect(wrapsExactly(type)).toBe(true);
  });

  it.each(['i64', 'u64'])('leaves checked and saturating arithmetic on %s alone', (type) => {
    /* Both only have to be exact *inside* the domain: a result outside it throws or clamps, and
       neither answer depends on bits the backend lost. */
    expect(codes(`fn f(a: ${type}, b: ${type}) -> ${type} {\n    return a + b\n}\n`)).toEqual([]);
    expect(codes(`fn f(a: ${type}, b: ${type}) -> ${type} {\n    return a +| b\n}\n`)).toEqual([]);
    expect(codes(`fn f(v: f64) -> ${type} {\n    return ${type}.clamp(v)\n}\n`)).toEqual([]);
  });
});

describe('the arithmetic a compiled module performs', () => {
  it('throws on a `u64` overflow that the old bound let through', async () => {
    /*
     * The regression in one line. `$chk(v, 64, false)` computed `hi = 2 ** 64 - 1`, which *is*
     * `2 ** 64` as a double — so nothing was ever outside it, and a `u64` sum silently kept going
     * with bits it had already lost.
     */
    const module = await run(
      'fn add(a: u64, b: u64) -> u64 {\n    return a + b\n}\n',
    );
    const add = module.add as (a: number, b: number) => number;

    expect(add(2 ** 52, 2 ** 52 - 1)).toBe(2 ** 53 - 1);
    expect(() => add(2 ** 53 - 1, 1)).toThrow(RangeError);
  });

  it('saturates a `u64` to the domain it really has', async () => {
    const module = await run('fn top(a: u64, b: u64) -> u64 {\n    return a +| b\n}\n');
    const top = module.top as (a: number, b: number) => number;
    expect(top(2 ** 53 - 1, 1000)).toBe(2 ** 53 - 1);
  });

  it.each([
    ['u8', 255, 1, 0],
    ['u8', 0, 1, 255],
    ['i8', 127, 1, -128],
    ['u32', 4294967295, 1, 0],
    ['i32', 2147483647, 1, -2147483648],
  ])('wraps %s: %d %s 1 -> %d', async (type, from, _delta, expected) => {
    const module = await run(
      `fn step(a: ${type}, b: ${type}) -> ${type} {\n    return a +% b\n}\n`,
    );
    const step = module.step as (a: number, b: number) => number;
    /* The second row is a subtraction written as an addition of the type's own wrap-around, so the
       table stays one shape. `0 +% 1` on a `u8` is 1; `0 - 1` is what wraps to 255. */
    expect(step(from, from === 0 ? -1 : 1)).toBe(expected);
  });

  it('emits the bounds as literals rather than computing a power per operation', () => {
    /* Integer arithmetic is on a path a script runs per frame, and `2 ** 31` twice per `+` is work
       the compiler already knew the answer to. */
    const { code } = compile('fn f(a: i32, b: i32) -> i32 {\n    return a + b\n}\n');
    expect(code).toContain('$chk(a + b, -2147483648, 2147483647)');
    expect(code).not.toContain('2 ** ');
  });
});

import { describe, expect, it } from 'vitest';
import { MATH_CAPABILITIES, mathImplementation } from './math.ts';

describe('std/math', () => {
  it('declares every function it implements, and implements every one it declares', () => {
    /* A declaration with no implementation fails at the call with the namespace's own name; an
       implementation with no declaration is unreachable from a script and nothing would say so. */
    const declared = new Set(MATH_CAPABILITIES.map((capability) => capability.name));
    const implemented = new Set(Object.keys(mathImplementation()));
    expect([...declared].filter((name) => !implemented.has(name)), 'declared, not implemented').toEqual([]);
    expect([...implemented].filter((name) => !declared.has(name)), 'implemented, not declared').toEqual([]);
  });

  it('exponentiates, which is what a frame-rate-independent ease needs', () => {
    /*
     * `1 - exp(-rate * dt)` is how every engine writes a damp, and core exports `damp` for
     * exactly it. Without this a script's options were a fixed fraction per frame — twice as
     * fast at 120 Hz — or a polynomial nobody could check.
     */
    const math = mathImplementation() as { exp: (x: number) => number };
    expect(math.exp(0)).toBe(1);
    expect(math.exp(1)).toBeCloseTo(Math.E, 5);
    expect(math.exp(-1)).toBeCloseTo(1 / Math.E, 5);
  });

  it('rounds every result to f32, because the language default is f32', () => {
    /* A library function returning a double would be the one value in an expression that had not
       been rounded, and the difference shows up as a replay that does not match. */
    const math = mathImplementation() as { exp: (x: number) => number; sqrt: (x: number) => number };
    expect(math.exp(1)).toBe(Math.fround(Math.exp(1)));
    expect(math.sqrt(2)).toBe(Math.fround(Math.sqrt(2)));
  });
});

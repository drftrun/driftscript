import { describe, expect, it } from 'vitest';
import { MATH_CAPABILITIES, mathImplementation } from './math.ts';
import { stdImplementations } from './index.ts';
import { compileDriftScript, singleFileHost } from '../compiler/index.ts';
import { createRegistry } from '../registry/capability.ts';
import { defineTarget } from '../registry/manifest.ts';
import { registerStd } from './index.ts';

/**
 * Compile a script against the standard library and run it, with the real implementations bound.
 *
 * The rounding property below is about what a *call* produces, and after 1.5.0 no single file holds
 * it: the implementation computes in double and the compiler narrows at the call site, because only
 * the compiler knows which width the call resolved to. Checking either half alone would pass while
 * the pair was broken — which is the shape `AGENTS.md` means by checking the artefact rather than
 * the source that produced it.
 */
const runStd = async (source: string) => {
  const registry = createRegistry();
  registerStd(registry);
  const result = compileDriftScript(source, {
    filename: 'm.drs',
    host: singleFileHost(),
    registry,
    manifest: defineTarget('nothing', []),
    mode: 'development',
  });
  if (result.diagnostics.length > 0) {
    throw new Error(result.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  }
  const mod = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
  )) as Record<string, (...args: never[]) => unknown> & { __bind: (host: unknown) => void };
  mod.__bind(stdImplementations());
  return mod;
};

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

  it('rounds a single-precision call to f32, because the language default is f32', async () => {
    /* A library function returning a double would be the one value in an expression that had not
       been rounded, and the difference shows up as a replay that does not match. Asserted through
       a compiled call rather than on the implementation, because that is where the rounding is
       now — see `mathImplementation` for why it had to move. */
    const mod = await runStd(
      'import { exp, sqrt } from "std/math"\n\n' +
        'fn e() -> f32 {\n    return math.exp(1)\n}\n\n' +
        'fn root() -> f32 {\n    return math.sqrt(2)\n}\n',
    );
    expect(mod.e()).toBe(Math.fround(Math.exp(1)));
    expect(mod.root()).toBe(Math.fround(Math.sqrt(2)));
  });

  it('keeps full precision when the call is at f64', async () => {
    /* The other half of the same property, and the reason the rounding could not stay in the
       implementation: a double call that came back single precision would be the hole this release
       closes, reopened one layer down and much harder to see. */
    const mod = await runStd(
      'import { sqrt } from "std/math"\n\n' +
        'fn root(x: f64) -> f64 {\n    return math.sqrt(x)\n}\n',
    );
    expect(mod.root(2 as never)).toBe(Math.sqrt(2));
    expect(mod.root(2 as never)).not.toBe(Math.fround(Math.sqrt(2)));
  });

  it('takes its width from the argument that has one, not from a literal beside it', async () => {
    /* `math.clamp(v, 0, 1)` is the shape a consumer reported, and the literals must not decide the
       call: a left-to-right rule would have fixed this at f32 on the `0` and reported a mismatch
       pointing at the wrong argument. */
    const mod = await runStd(
      'import { clamp, lerp } from "std/math"\n\n' +
        'fn pin(v: f64) -> f64 {\n    return math.clamp(v, 0, 1)\n}\n\n' +
        'fn between(t: f64) -> f64 {\n    return math.lerp(0, 1, t)\n}\n',
    );
    expect(mod.pin(0.5 as never)).toBe(0.5);
    expect(mod.pin(9 as never)).toBe(1);
    /* 0.1 is not representable in single precision, so an f32 call would return the rounded one.
       This is the assertion that the literals adopted the argument's width rather than the other
       way round. */
    expect(mod.between(0.1 as never)).toBe(0.1);
  });

  it('resolves to f32 when nothing fixes the width, which is what every script meant before', async () => {
    const mod = await runStd(
      'import { lerp } from "std/math"\n\nfn f() -> f32 {\n    return math.lerp(0, 1, 0.1)\n}\n',
    );
    expect(mod.f()).toBe(Math.fround(0.1));
  });

  it('refuses two float widths in one call, and names the conversion', () => {
    const registry = createRegistry();
    registerStd(registry);
    const result = compileDriftScript(
      'import { min } from "std/math"\n\nfn f(a: f32, b: f64) -> f64 {\n    return math.min(a, b)\n}\n',
      {
        filename: 'm.drs',
        host: singleFileHost(),
        registry,
        manifest: defineTarget('nothing', []),
        mode: 'development',
      },
    );
    const mismatch = result.diagnostics.find((d) => d.code === 'DS0263');
    expect(mismatch, result.diagnostics.map((d) => d.code).join(', ')).toBeDefined();
    /* `a` fixed the call at f32, so `b` is the argument named and `f32.nearest` is the fix. */
    expect(mismatch?.message).toContain('f32.nearest');
  });
});

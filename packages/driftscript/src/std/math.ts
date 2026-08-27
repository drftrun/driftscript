/**
 * `std/math` — scalar arithmetic, provided by the language in every host.
 *
 * **Not `Vec3`, not `Quat`, not `Mat4`.** Those arrive through a linked capability, from whatever
 * maths a host already has, because a consumer with no renderer still has a language. What is here
 * is what a script can compute with nothing but numbers.
 *
 * Every function is `pure` and therefore callable from a `@deterministic` function. That is the
 * whole reason to have a standard library at all: a script that only computes needs no host, and a
 * host that provides nothing still runs it.
 */
import { type CapabilityDefinition, defineCapability } from '../registry/capability.ts';

export const MATH_MODULE = 'std/math';

const fn = (
  name: string,
  params: readonly { name: string; type: string }[],
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module: MATH_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: f32`).join(', ')}) -> f32`,
    params: params.map((p) => ({ name: p.name, type: 'f32' })),
    returns: 'f32',
    effects: ['pure'],
    deterministic: true,
    doc,
    implementation: `std.math.${name}`,
  });

export const MATH_CAPABILITIES: readonly CapabilityDefinition[] = [
  fn('abs', [{ name: 'x', type: 'f32' }], 'The magnitude of a number.'),
  fn('min', [{ name: 'a', type: 'f32' }, { name: 'b', type: 'f32' }], 'The smaller of two numbers.'),
  fn('max', [{ name: 'a', type: 'f32' }, { name: 'b', type: 'f32' }], 'The larger of two numbers.'),
  fn(
    'clamp',
    [{ name: 'x', type: 'f32' }, { name: 'low', type: 'f32' }, { name: 'high', type: 'f32' }],
    'A number pinned between two bounds.',
  ),
  fn(
    'lerp',
    [{ name: 'a', type: 'f32' }, { name: 'b', type: 'f32' }, { name: 't', type: 'f32' }],
    'A value between two others. `t` is not clamped.',
  ),
  fn('floor', [{ name: 'x', type: 'f32' }], 'The largest whole number no greater than this.'),
  fn('ceil', [{ name: 'x', type: 'f32' }], 'The smallest whole number no less than this.'),
  fn('round', [{ name: 'x', type: 'f32' }], 'The nearest whole number, halves rounding up.'),
  fn('sqrt', [{ name: 'x', type: 'f32' }], 'The square root. Negative input yields a NaN.'),
  fn('sin', [{ name: 'radians', type: 'f32' }], 'The sine of an angle in radians.'),
  fn('cos', [{ name: 'radians', type: 'f32' }], 'The cosine of an angle in radians.'),
  fn('atan2', [{ name: 'y', type: 'f32' }, { name: 'x', type: 'f32' }], 'The angle to a point, in radians.'),
  /*
   * **`exp` is here because damping is, and a script could not express it.**
   *
   * The frame-rate-independent ease every engine writes as `1 - exp(-rate * dt)` is the single
   * most common thing a behaviour does with a delta — core exports `damp` for exactly it — and
   * without this a script's only options were a fixed fraction per frame, which runs twice as
   * fast at 120 Hz, or a polynomial approximation nobody could check. Found by the first script
   * that eased anything.
   *
   * `log` is deliberately not added beside it. Nothing has asked for one, and the pair is the
   * kind of thing that arrives together out of symmetry rather than out of need.
   */
  fn('exp', [{ name: 'x', type: 'f32' }], "Euler's number raised to this power."),
];

/**
 * The implementations, which the language supplies rather than a host.
 *
 * `Math.fround` is applied at each result because the language's default numeric type is `f32` and
 * the generated arithmetic rounds at every operation. A library function that returned a double
 * would make `sqrt(2) * sqrt(2)` differ from the same expression written inline — a discrepancy
 * nobody would look for.
 */
export function mathImplementation(): Record<string, unknown> {
  const f = Math.fround;
  return {
    abs: (x: number) => f(Math.abs(x)),
    min: (a: number, b: number) => f(Math.min(a, b)),
    max: (a: number, b: number) => f(Math.max(a, b)),
    clamp: (x: number, low: number, high: number) => f(Math.min(high, Math.max(low, x))),
    lerp: (a: number, b: number, t: number) => f(a + (b - a) * t),
    floor: (x: number) => f(Math.floor(x)),
    ceil: (x: number) => f(Math.ceil(x)),
    round: (x: number) => f(Math.round(x)),
    sqrt: (x: number) => f(Math.sqrt(x)),
    sin: (radians: number) => f(Math.sin(radians)),
    cos: (radians: number) => f(Math.cos(radians)),
    atan2: (y: number, x: number) => f(Math.atan2(y, x)),
    exp: (x: number) => f(Math.exp(x)),
  };
}

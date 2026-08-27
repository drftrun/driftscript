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
 *
 * **Every signature here is `float`, which is either width, the same one throughout the call.**
 * These were all written `f32` and that was the right default and the wrong ceiling: a bare literal
 * is `f32`, so `math.clamp(x, 0, 1)` still resolves exactly as it always did, but a script holding
 * an `f64` — which is what a generic ECS accessor hands back, because it cannot know a field's
 * width — could not call any of this and had no conversion to reach for. A consumer reported it as
 * a hole in the language, and it was one. See `FLOAT` in `registry/capability.ts` for the rule.
 */
import { FLOAT, type CapabilityDefinition, defineCapability } from '../registry/capability.ts';

export const MATH_MODULE = 'std/math';

const fn = (
  name: string,
  params: readonly { name: string }[],
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module: MATH_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${FLOAT}`).join(', ')}) -> ${FLOAT}`,
    params: params.map((p) => ({ name: p.name, type: FLOAT })),
    returns: FLOAT,
    effects: ['pure'],
    deterministic: true,
    doc,
    implementation: `std.math.${name}`,
  });

export const MATH_CAPABILITIES: readonly CapabilityDefinition[] = [
  fn('abs', [{ name: 'x' }], 'The magnitude of a number.'),
  fn('min', [{ name: 'a' }, { name: 'b' }], 'The smaller of two numbers.'),
  fn('max', [{ name: 'a' }, { name: 'b' }], 'The larger of two numbers.'),
  fn(
    'clamp',
    [{ name: 'x' }, { name: 'low' }, { name: 'high' }],
    'A number pinned between two bounds.',
  ),
  fn(
    'lerp',
    [{ name: 'a' }, { name: 'b' }, { name: 't' }],
    'A value between two others. `t` is not clamped.',
  ),
  fn('floor', [{ name: 'x' }], 'The largest whole number no greater than this.'),
  fn('ceil', [{ name: 'x' }], 'The smallest whole number no less than this.'),
  fn('round', [{ name: 'x' }], 'The nearest whole number, halves rounding up.'),
  fn('sqrt', [{ name: 'x' }], 'The square root. Negative input yields a NaN.'),
  fn('sin', [{ name: 'radians' }], 'The sine of an angle in radians.'),
  fn('cos', [{ name: 'radians' }], 'The cosine of an angle in radians.'),
  fn('atan2', [{ name: 'y' }, { name: 'x' }], 'The angle to a point, in radians.'),
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
  fn('exp', [{ name: 'x' }], "Euler's number raised to this power."),
];

/**
 * The implementations, which the language supplies rather than a host.
 *
 * **Each computes in double and rounds nothing, because the call site rounds.** These used to apply
 * `Math.fround` to every result, for a reason that is still exactly right: the language's default
 * numeric type is `f32`, the generated arithmetic rounds at every operation, and a library function
 * that returned a double would make `sqrt(2) * sqrt(2)` differ from the same expression written
 * inline — a discrepancy nobody would look for. Rounding here stopped working the moment these
 * signatures became `float`, since a genuine `f64` call would have been silently narrowed to single
 * precision by the very code meant to protect precision.
 *
 * So the rounding moved one step out, to the only place that knows the width: the compiler wraps an
 * `f32`-resolved call in `Math.fround` and leaves an `f64` one alone. **A single-precision call
 * emits the identical arithmetic it did before** — one round, over the same double computation,
 * in the same place in the expression.
 *
 * What this costs is that calling one of these from JavaScript by hand no longer rounds. Nothing
 * does that: these are reached through a generated module's bound namespace, and `stdImplementations`
 * is not exported from the package barrel.
 */
export function mathImplementation(): Record<string, unknown> {
  return {
    abs: (x: number) => Math.abs(x),
    min: (a: number, b: number) => Math.min(a, b),
    max: (a: number, b: number) => Math.max(a, b),
    clamp: (x: number, low: number, high: number) => Math.min(high, Math.max(low, x)),
    lerp: (a: number, b: number, t: number) => a + (b - a) * t,
    floor: (x: number) => Math.floor(x),
    ceil: (x: number) => Math.ceil(x),
    round: (x: number) => Math.round(x),
    sqrt: (x: number) => Math.sqrt(x),
    sin: (radians: number) => Math.sin(radians),
    cos: (radians: number) => Math.cos(radians),
    atan2: (y: number, x: number) => Math.atan2(y, x),
    exp: (x: number) => Math.exp(x),
  };
}

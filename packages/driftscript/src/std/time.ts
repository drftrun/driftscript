/**
 * `std/time` — duration arithmetic, and nothing that reads a clock.
 *
 * **This is the half of time that is pure**, and the split is R9's sharpest example. Converting
 * between durations, comparing them, taking the smaller of two — none of it observes anything, so
 * all of it is available in every host and inside a `@deterministic` function.
 *
 * Reading a clock is `drift/time`, is a host capability, and carries `clock.read`. A language that
 * put both here would have made every script that formats a duration into one that could secretly
 * read the wall clock.
 *
 * Durations are plain seconds, because units are erased: `250ms` is already `0.25` by the time any
 * of this sees it.
 *
 * **The width is `float`, meaning either one, decided by the call** — the same change `std/math`
 * took and for the same reported reason. A duration is `f32` wherever a literal or a frame delta
 * produced it, which is nearly everywhere; it is `f64` the moment it came out of a generic accessor
 * that could not know a field's width, and a `progress` a script could not call on the timestamp it
 * had just read was the same hole one module along.
 */
import { FLOAT, type CapabilityDefinition, defineCapability } from '../registry/capability.ts';

export const TIME_MODULE = 'std/time';

const fn = (
  name: string,
  params: readonly { name: string }[],
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module: TIME_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${FLOAT}`).join(', ')}) -> ${FLOAT}`,
    params: params.map((p) => ({ name: p.name, type: FLOAT })),
    returns: FLOAT,
    effects: ['pure'],
    deterministic: true,
    doc,
    implementation: `std.time.${name}`,
  });

export const TIME_CAPABILITIES: readonly CapabilityDefinition[] = [
  fn(
    'seconds',
    [{ name: 'duration' }],
    'A duration in seconds. An identity, and the place a reader learns seconds are the base unit.',
  ),
  fn(
    'milliseconds',
    [{ name: 'duration' }],
    'A duration in milliseconds, for formatting. `250ms` is already 0.25 by the time this sees it.',
  ),
  fn(
    'progress',
    [{ name: 'elapsed' }, { name: 'total' }],
    'How far through a duration something is, from 0 to 1. A zero total yields 1 rather than a NaN.',
  ),
];

/** Computed in double and rounded by the call site, for the reason `mathImplementation` gives. */
export function timeImplementation(): Record<string, unknown> {
  return {
    seconds: (duration: number) => duration,
    milliseconds: (duration: number) => duration * 1000,
    progress: (elapsed: number, total: number) =>
      /* A zero total yields 1 rather than a NaN, because "a duration of nothing is over" is the
         answer every caller wants and a NaN propagates silently through arithmetic for a whole
         frame before anybody sees it. */
      total === 0 ? 1 : Math.min(1, Math.max(0, elapsed / total)),
  };
}

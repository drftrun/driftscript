import { describe, expect, it } from 'vitest';
import { TIME_CAPABILITIES, timeImplementation } from './time.ts';
import { clearClockSource } from '../runtime/clocks.ts';

describe('std/time', () => {
  it('is pure and deterministic in every entry, because none of it observes anything', () => {
    /* The whole point of the split: a script that formats a duration must not thereby become one
       that could secretly read a clock. Reading one is `drift/time` and carries `clock.read`. */
    for (const capability of TIME_CAPABILITIES) {
      expect(capability.effects, `std/time.${capability.name}`).toEqual(['pure']);
      expect(capability.deterministic, `std/time.${capability.name}`).toBe(true);
    }
  });

  it('answers with no clock source supplied at all', () => {
    /* The assertion that makes "pure" mean something rather than being a label: with the runtime's
       clock deliberately torn down, duration arithmetic still works. Anything here that had reached
       for a clock would refuse instead — `readClock` throws rather than returning zero. */
    clearClockSource();
    const time = timeImplementation() as Record<string, (...args: number[]) => number>;

    expect(time.seconds(2)).toBe(2);
    expect(time.milliseconds(0.25)).toBe(250);
    expect(time.progress(1, 4)).toBe(0.25);
  });

  it('reports a duration of nothing as over, rather than as a NaN', () => {
    const time = timeImplementation() as Record<string, (...args: number[]) => number>;
    expect(time.progress(0, 0)).toBe(1);
  });
});

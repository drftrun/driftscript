import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ClockSource,
  clearClockSource,
  deadlineAfter,
  readClock,
  setClockSource,
} from './clocks.ts';

/** A host driven by hand, so a test can say what time it is rather than wait for it. */
const source = (steps: number, frame: number, wall: number, step = 1 / 60): ClockSource => ({
  fixedSteps: () => steps,
  fixedStep: () => step,
  frame: () => frame,
  wall: () => wall,
});

describe('the clock source', () => {
  beforeEach(() => {
    clearClockSource();
  });

  it('refuses in words when no host has supplied one', () => {
    /*
     * The alternative is returning zero, and zero is a *plausible* time: a task awaiting a
     * duration against a clock frozen at zero never resumes, and nothing anywhere reports why.
     * A scene that silently never fires reads as a bug in the script rather than in the wiring.
     */
    expect(() => readClock('fixed')).toThrow(/clock source/);
    expect(() => readClock('fixed')).toThrow(/setClockSource/);
  });

  it('names the clock that was read, so a host knows which number is missing', () => {
    expect(() => readClock('wall')).toThrow(/`wall`/);
  });

  it('refuses a deadline too, rather than handing back one measured against nothing', () => {
    expect(() => deadlineAfter('fixed', 1)).toThrow(/clock source/);
  });

  it('reads each of the three clocks from the source the host supplied', () => {
    setClockSource(source(90, 2.5, 3.5));

    expect(readClock('fixed')).toBe(90);
    expect(readClock('frame')).toBe(2.5);
    expect(readClock('wall')).toBe(3.5);
  });

  it('reads through to the source on every call rather than sampling it once', () => {
    let steps = 0;
    setClockSource({ fixedSteps: () => steps, fixedStep: () => 1 / 60, frame: () => 0, wall: () => 0 });

    expect(readClock('fixed')).toBe(0);
    steps = 30;
    expect(readClock('fixed')).toBe(30);
  });

  it('refuses again once cleared, rather than serving the numbers of a torn-down loop', () => {
    /* A source that outlived its scene is worse than none: it answers, and every answer is about
       a loop that has stopped. Tearing down is what a host does between scenes. */
    setClockSource(source(9, 9, 9));
    clearClockSource();

    expect(() => readClock('fixed')).toThrow(/clock source/);
  });
});

describe('a deadline', () => {
  beforeEach(() => {
    clearClockSource();
  });

  it('names the step that reaches the duration, not the one after it', () => {
    /* Every figure below is derived by hand from the duration and a sixtieth. */
    setClockSource(source(0, 0, 0));

    expect(deadlineAfter('fixed', 0.5)).toBe(30);
    expect(deadlineAfter('fixed', 0.1)).toBe(6);
    expect(deadlineAfter('fixed', 1)).toBe(60);
    expect(deadlineAfter('fixed', 2)).toBe(120);
    expect(deadlineAfter('fixed', 0.25)).toBe(15);
    expect(deadlineAfter('fixed', 10)).toBe(600);
    expect(deadlineAfter('fixed', 0)).toBe(0);
  });

  it('does not wait an extra step for a duration the division misplaces', () => {
    /*
     * **The case a bare `ceil` gets wrong**, and it is not a round number: 4150ms is exactly 249
     * steps of a sixtieth, and `4.15 / (1/60)` is `249.00000000000003`. Ceiling that waits 250.
     * Three of the first ten thousand whole milliseconds do this, and 98 of the first six thousand
     * durations written as a multiple of the step — the first of those being 125.
     */
    setClockSource(source(0, 0, 0));
    expect(deadlineAfter('fixed', 4.15)).toBe(249);
    expect(deadlineAfter('fixed', 125 * (1 / 60))).toBe(125);
  });

  it('rounds a duration between two steps up to the one that reaches it', () => {
    /* 383ms is 22.98 steps of a sixtieth. Twenty-three is the first that reaches it, and the
       snapping above must not pull it back to twenty-two. */
    setClockSource(source(0, 0, 0));
    expect(deadlineAfter('fixed', 0.383)).toBe(23);
  });

  it('is exact at every duration expressed in the host own step', () => {
    setClockSource(source(0, 0, 0));
    for (let n = 0; n <= 600; n += 1) {
      expect(deadlineAfter('fixed', n * (1 / 60)), `${n} steps`).toBe(n);
    }
  });

  it('rounds a duration shorter than a step up to one step, because zero would never wait', () => {
    setClockSource(source(0, 0, 0));
    expect(deadlineAfter('fixed', 0.001)).toBe(1);
  });

  it('counts from where the clock is now, not from the start of the loop', () => {
    setClockSource(source(1000, 0, 0));
    expect(deadlineAfter('fixed', 0.5)).toBe(1030);
  });

  it('honours a host whose step is not a sixtieth', () => {
    setClockSource(source(0, 0, 0, 1 / 50));
    expect(deadlineAfter('fixed', 0.5)).toBe(25);
  });

  it('adds plain seconds on the two clocks that have no exact unit to protect', () => {
    setClockSource(source(0, 2, 5));
    expect(deadlineAfter('frame', 1.5)).toBe(3.5);
    expect(deadlineAfter('wall', 1.5)).toBe(6.5);
  });
});

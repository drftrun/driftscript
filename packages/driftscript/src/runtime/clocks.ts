/**
 * The three clocks a script can wait on, and the seam where the host supplies their numbers.
 *
 * **The language declares the interface; the host supplies the numbers.** Nothing here reads a
 * clock — this package may not, because `AGENTS.md`'s determinism rule forbids `Date.now()` and
 * `performance.now()` on any path a consumer might simulate, and because `driftscript` has no
 * engine to ask. What it has is three names and a place to put an implementation of them.
 *
 * The three are the running loop's own, and the mapping is exact: `fixed` is the step
 * `simulate(dt)` receives, `frame` is the clamped delta `render` animates against, and `wall` is
 * that same gap with nothing done to it.
 *
 * ---
 *
 * ## Two things read these numbers, and only one of them is a capability
 *
 * `drift/time` is a script **reading** a delta — `time.fixedDelta()` — and it goes through the
 * host's implementation map like every other capability. This module is what the task scheduler
 * **waits** against: `await fixedTime(500ms)` compares a deadline to `readClock('fixed')`.
 *
 * The two obey different determinism rules and both are right. A `@deterministic` function may not
 * *read* a clock, even the fixed one, because a simulation is given its delta and one that reached
 * out for it has stopped being a function of its inputs. A `@deterministic` task may *await*
 * `fixedTime`, because a resume point counted in fixed steps is a function of the tick count and
 * replays identically. The design's §13 records the split.
 *
 * ---
 *
 * ## The fixed clock counts steps. The other two count seconds
 *
 * **This asymmetry is the whole point of the file and was paid for.** The first version reported
 * all three as accumulated seconds, and the test that drove a loop by hand caught what that costs:
 * adding `1/60` thirty times gives `0.49999999999999994`, so `await fixedTime(500ms)` misses the
 * step it names and fires on the thirty-first. The error is tiny — about `1.3e-10` steps across a
 * minute — and it does not need to be large, because it only has to fall on the wrong side of one
 * comparison.
 *
 * A count of whole steps has no such error at any duration, which matters here and nowhere else:
 * the fixed clock is the only one a `@deterministic` task may await, so it is the only one whose
 * resume point is a promise about replay. `AGENTS.md` says the same thing one level up — time is a
 * tick count the caller supplies. Frame and wall time have no exact unit to protect and are not
 * deterministic in any case, so seconds is what they are.
 *
 * **The cost is that `readClock` returns different units per clock**, which would be a trap if
 * anything had to know. Nothing does: a deadline is always produced by `deadlineAfter` in the same
 * clock's unit, and the scheduler only ever compares the two. **What would make this wrong** is a
 * caller that formats a `readClock` result for a person, which would print a step count as though
 * it were seconds — so nothing exports `readClock` beyond this package.
 *
 * **A host whose fixed clock goes backwards was the open question here, and it is answered.** The
 * worry was rollback netcode: a host that resimulates moves its fixed clock backwards, and a
 * deadline that could not express "resume at step N" across that would resume at the wrong step or
 * never. DriftEngine's Track J built such a host in 2026-09, and the shape turned out to be right
 * already — **because the fixed clock is a step count rather than seconds, a deadline is an
 * absolute step number**, and an absolute number means the same thing after the clock moves in
 * either direction. A task waiting for step 500 is still waiting for step 500 after a rewind to
 * 483, and reaches it on the replayed step 500.
 *
 * What the deferral was protecting against is a deadline held as a *remaining duration*, which
 * would be re-measured from wherever the clock happened to be and would slip by the whole rewind
 * every time. Nothing here holds one. `clocks.test.ts` asserts both halves against a host driven
 * backwards by hand.
 *
 * **What a rewind still does not restore is the scheduler's own state** — which tasks are alive and
 * where each is suspended. That is `tasks.ts`'s to answer rather than this file's, and it is a row
 * rather than a guard: the layout it would need already exists, because `frameLayout` enumerates
 * every slot a task's frame carries and a hot patch already depends on it.
 */

/** Which of the loop's three clocks. */
export type Clock = 'fixed' | 'frame' | 'wall';

/**
 * The numbers a host supplies from its running loop.
 *
 * Plain functions rather than a record of values, so a host answers at the moment of the question.
 * A record would be a snapshot, and a scheduler reading a snapshot taken at the top of the frame
 * cannot see time cross a deadline inside it.
 */
export interface ClockSource {
  /** Simulation steps completed since the loop started. A whole count, never a fraction. */
  fixedSteps(): number;
  /** Seconds in one simulation step. Constant for the life of a loop. */
  fixedStep(): number;
  /** Seconds of frame time, clamped the way the loop clamps it. */
  frame(): number;
  /** Seconds of real time, unclamped. Diagnostics only — nothing that animates should wait on it. */
  wall(): number;
}

let current: ClockSource | undefined;

/** Give the runtime its clock. A host calls this once, where it starts its loop. */
export function setClockSource(source: ClockSource): void {
  current = source;
}

/**
 * Forget the clock.
 *
 * A host calls this when its loop stops. A source that outlived its scene is worse than no source
 * at all: it answers every question, and every answer is about a loop that is no longer running.
 */
export function clearClockSource(): void {
  current = undefined;
}

function source(clock: Clock): ClockSource {
  if (current === undefined) {
    throw new Error(
      `DriftScript has no clock source, so \`${clock}\` cannot be read. A host supplies one with ` +
        '`setClockSource` where it starts its loop; without it a duration has nothing to measure ' +
        'against.',
    );
  }
  return current;
}

/**
 * Read one clock, in that clock's own unit, or refuse in words.
 *
 * **Refusing rather than returning zero**, because zero is a plausible time. A task awaiting a
 * duration against a clock frozen at zero simply never resumes, and a scene where nothing happens
 * reads as a bug in the script rather than as a host that was never wired — which is
 * `AGENTS.md`'s rule against a silent no-op, in the one place it is most expensive to break.
 *
 * The cost is a throw on a path a frame can reach, against the reliability rule that the frame loop
 * never throws after boot. It is bounded: a host sets its source where it starts its loop, so the
 * only frame this can reach is the first one after a boot that forgot to.
 */
export function readClock(clock: Clock): number {
  const host = source(clock);
  if (clock === 'fixed') return host.fixedSteps();
  return clock === 'frame' ? host.frame() : host.wall();
}

/**
 * What `readClock(clock)` will read once `seconds` have passed — an absolute value to wait for.
 *
 * On the fixed clock this is a step count, and the step it names is **the first one that reaches
 * the duration**, which is what a script writing `await fixedTime(500ms)` means.
 *
 * **A plain `ceil` of the division waits one step too long for some durations**, measured against a
 * sixtieth: 98 of the 6,001 durations `n * step` for n up to 6,000 divide back above `n` — the
 * first is n=125, at `125.00000000000001` — and so do 3 of the first 10,000 whole milliseconds, the
 * first being `4150ms`, which divides to `249.00000000000003` and would wait 250 steps for a
 * duration that is exactly 249. Round durations are unaffected: `0.5 / (1/60)` is exactly 30.
 *
 * So a division landing within a billionth of a step of an integer is **snapped to it**, and
 * anything else rounds up. The cost is that a duration deliberately placed a sub-nanostep above a
 * boundary rounds down instead of up. **What would make this wrong** is a step short enough for a
 * billionth of one to be a time anybody could mean: at sixty steps a second that is seventeen
 * picoseconds, and a host running steps that short has a larger problem than this rounding.
 */
export function deadlineAfter(clock: Clock, seconds: number): number {
  const host = source(clock);
  if (clock !== 'fixed') {
    return (clock === 'frame' ? host.frame() : host.wall()) + seconds;
  }

  const raw = seconds / host.fixedStep();
  const nearest = Math.round(raw);
  const steps = Math.abs(raw - nearest) < 1e-9 ? nearest : Math.ceil(raw);
  return host.fixedSteps() + steps;
}

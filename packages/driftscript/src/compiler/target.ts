/**
 * What a second means on the target being compiled for.
 *
 * **A file of its own because the alternative put a host's clock inside the parser.** The fixed step
 * was a constant in `parser.ts`, and its comment already said what would make that wrong: a host
 * running a different one. That host compiled every `update at …Hz` to the wrong stride — `1Hz`
 * became sixty steps, which at thirty a second is every two seconds — silently, with nothing in the
 * output to compare afterwards.
 *
 * The division of labour it restores: a parser answers *what did the author write*, and a target
 * answers *what does this host's simulation clock mean*. A rate is syntax; a stride is neither.
 *
 * Both the parser and the emitter need the number — one to compute a stride, the other to record
 * what the strides were computed against — and neither should import the other to get it.
 */

/**
 * The fixed step assumed when a caller does not say, as steps per second.
 *
 * Sixty rather than a required option, because it is what the engine this language grew up with
 * runs and because making it required would break every consumer to state something all of them
 * already agree on. A host that differs passes `CompileOptions.fixedStepsPerSecond`.
 */
export const DEFAULT_FIXED_STEPS_PER_SECOND = 60;

/**
 * The rates that divide a target's fixed step exactly, as a diagnostic lists them.
 *
 * Worked out rather than written down: the list in `DS0133` was `1, 2, 3, 4, 5, 6, 10, 12, 15, 20,
 * 30 or 60Hz`, which is the answer for sixty and for no other host — so the moment the step became
 * configurable, the sentence naming the way out of the error would have been wrong.
 */
export function ratesDividing(fixedStepsPerSecond: number): string[] {
  const rates: string[] = [];
  for (let candidate = 1; candidate <= fixedStepsPerSecond; candidate += 1) {
    if (fixedStepsPerSecond % candidate === 0) rates.push(`${candidate}`);
  }
  return rates;
}

/**
 * What the build side costs, measured separately so the runtime floor cannot hide it.
 *
 * **It imports `compileDriftScript` rather than a constant, and that is the whole point.** The
 * first version of this fixture imported the entry point's name, which tree-shakes to nothing and
 * measured 77 bytes — a fixture that reports honestly on an incomplete input, which is the hardest
 * kind of wrong to notice. A fixture measuring the compiler has to reach the compiler.
 *
 * One number for both entry points would let the parser grow inside the runtime's tolerance, which
 * is exactly what the separate `exports` entry exists to prevent.
 */
import { compileDriftScript } from 'driftscript/compiler';
export const entry = compileDriftScript;

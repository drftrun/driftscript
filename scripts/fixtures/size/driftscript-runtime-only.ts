/**
 * The extraction rehearsal, run on every commit.
 *
 * This bundles the language runtime with **no engine present at all**. If it links, the layer is
 * host-neutral in fact rather than by policy; if it needs `@driftengine/core` to resolve, the
 * boundary has been crossed by something a type-only import made invisible to review.
 *
 * **It imports the whole runtime surface a consumer actually uses**, not one symbol. An earlier
 * version imported `identity` alone, which tree-shakes to nothing and would have stayed 71 bytes
 * however much the barrel grew — a fixture that reports honestly on an incomplete input, which is
 * the hardest kind of wrong to notice. Loading a module, patching it, describing a capability and
 * declaring a target is what a host does, so it is what gets measured.
 *
 * It is also the payload floor the design promises: a production bundle that reaches the parser
 * fails here, which is the only kind of assurance about payload this repository accepts.
 */
import {
  createRegistry,
  defineCapability,
  defineTarget,
  disposeModule,
  loadModule,
  patchModule,
  providesModule,
} from 'driftscript';

export const entry = [
  loadModule,
  patchModule,
  disposeModule,
  createRegistry,
  defineCapability,
  defineTarget,
  providesModule,
];

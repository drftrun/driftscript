/**
 * The DriftScript runtime barrel. Named exports only, no default, and no barrel but this one.
 *
 * **The compiler is deliberately not reachable from here.** A consumer bundling a production
 * application resolves this entry point, and must not be able to reach a lexer, a parser or a
 * type checker through it. `driftscript/compiler` is a separate entry in the `exports` map for
 * that reason, because a bundler can only drop what the module graph does not reach and a shared
 * barrel would reach it.
 *
 * The cost is two entry points to keep honest rather than one. What would make it wrong is a
 * runtime feature that genuinely needs the parser — which would mean the language had acquired an
 * `eval`, and the design refuses that rather than measuring it. `scripts/size-gate.test.mjs`
 * measures the separation: the runtime is a fraction of the compiler and shares none of it.
 *
 * The registry and the manifest are exported from **here** rather than from the compiler entry, and
 * that is not an oversight. A host registers its capabilities and declares its target at runtime,
 * beside the code that implements them; only the *linker* that reads them is build-side. Putting
 * them behind the compiler entry would mean a host could not describe itself without shipping a
 * parser.
 */
export { identity } from './std/core.ts';

export type {
  DriftComponentInfo,
  DriftEntityInfo,
  DriftModule,
  DriftModuleInfo,
  DriftPrefabInfo,
  DriftSystemInfo,
} from './runtime/module.ts';
export { bindHost, disposeModule, loadModule, rebindHost } from './runtime/module.ts';

export type { Clock, ClockSource } from './runtime/clocks.ts';
/* A host supplies the loop's three elapsed times; `readClock` stays internal, because the only
   caller is the scheduler in this package and exporting a reader would invite a consumer to build
   a second scheduler against it. */
export { clearClockSource, setClockSource } from './runtime/clocks.ts';

export type { Scope, TaskBody, TaskFrame, TaskHandle, TaskStep } from './runtime/tasks.ts';
export { createScope, liveTaskCount, spawn, tickTasks } from './runtime/tasks.ts';

export type { Subscription } from './runtime/events.ts';
/* A host listens for a script's events through the same door the generated code uses. `emit` is
   here too so a host can push one *into* a script, which is what makes the two directions
   symmetric rather than the language only ever talking to itself. */
export { emit, listenerCount, on } from './runtime/events.ts';

export type { Machine, StateDefinition } from './runtime/machine.ts';
export { createMachine } from './runtime/machine.ts';

export type { FieldId, FieldSchema, Schema } from './runtime/state.ts';
export { fieldId } from './runtime/state.ts';

export type { MigrationResult } from './runtime/migrate.ts';
export { migrate } from './runtime/migrate.ts';

export type { PatchResult } from './runtime/hot.ts';
export { patchModule } from './runtime/hot.ts';

export type { TargetManifest } from './registry/manifest.ts';
export { STD_MODULES, defineTarget, providesModule } from './registry/manifest.ts';

export type {
  CapabilityDefinition,
  CapabilityParam,
  CapabilityRegistry,
  Effect,
  OpaqueType,
  TypeName,
} from './registry/capability.ts';
export { createRegistry, defineCapability } from './registry/capability.ts';
/* A registry as data, so a process that cannot import the host that built it can still know what
   that host provides. R2 is what makes this possible: nothing in a definition is a function. */
export type { SerializedRegistry } from './registry/serialize.ts';
export {
  registryFromJson,
  serializeRegistry,
  targetFromCapabilities,
} from './registry/serialize.ts';

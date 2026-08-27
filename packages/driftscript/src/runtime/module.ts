/**
 * A loaded DriftScript module, and the indirection that makes hot reload possible.
 *
 * **Hot reload is part of the initial runtime architecture rather than a later addition**, and this
 * file is where that decision is visible. A runtime that gained it later would be a runtime whose
 * module identity was designed without it — callers would hold direct references to generated
 * functions, and replacing one would mean finding every holder.
 *
 * So a caller holds a `DriftModule` and reaches functions through `exports`. Swapping a function is
 * one assignment into a record every caller already reads through, and nothing has to be found.
 *
 * The cost is one property lookup per call, which is why a per-frame caller should hoist the
 * function outside its loop — and why doing so is a *choice a consumer makes* rather than something
 * the runtime forces, since hoisting is exactly what breaks hot reload for that call site.
 */
import { deadlineAfter } from './clocks.ts';
import type { Schema } from './state.ts';
import { emit, onGenerated } from './events.ts';
import { createMachine } from './machine.ts';
import { type Scope, createScope, spawn } from './tasks.ts';

/** What the generated `__drift` export carries. Emitted as a literal, so a bundler sees through it. */
export interface DriftModuleInfo {
  readonly module: string;
  readonly requires: readonly string[];
  /** Field names per record, in declaration order. What a hot patch compares. */
  readonly shapes: Readonly<Record<string, readonly string[]>>;
  /**
   * Each record's fields with their stable ids. What a migration matches on.
   *
   * Optional because a module compiled before schemas existed has none, and a runtime that threw on
   * one would refuse to load a module that works perfectly for everything except migrating.
   */
  readonly schemas?: Readonly<Record<string, Schema>>;
  /**
   * What a host builds a world from: the components, entities, systems and prefabs a module
   * declares.
   *
   * Optional for the same reason `schemas` is — a module compiled before these existed has none,
   * and a runtime that threw on one would refuse to load a module that works perfectly for
   * everything except entities.
   */
  readonly components?: readonly DriftComponentInfo[];
  readonly entityTypes?: readonly DriftEntityInfo[];
  readonly systems?: readonly DriftSystemInfo[];
  readonly prefabs?: readonly DriftPrefabInfo[];
}

/** A component a module declares, or asserts about its host. */
export interface DriftComponentInfo {
  readonly name: string;
  /** The host registered it; the module only asserts its shape. Nothing is created for one. */
  readonly fromHost: boolean;
  readonly schema: Schema;
  /** `@editor(…)` per field. Absent in a production build, which strips it. */
  readonly editor?: Readonly<Record<string, unknown>>;
}

/** An entity: the components it requires, and the implicit component its own fields became. */
export interface DriftEntityInfo {
  readonly name: string;
  readonly requires: readonly string[];
  readonly ownComponent: string | null;
}

/** A system, with the **inferred** access rather than whatever the author declared. */
export interface DriftSystemInfo {
  readonly name: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly after: readonly string[];
  readonly everyTicks: number;
}

/** A prefab: components and the constant values to write into them. */
export interface DriftPrefabInfo {
  readonly name: string;
  readonly components: readonly {
    readonly name: string;
    readonly values: Readonly<Record<string, number | string | boolean>>;
  }[];
}

/**
 * What generated code calls the scheduler through.
 *
 * A small object rather than the module's whole runtime surface: generated code should be able to
 * reach exactly what the forms it contains need, and nothing a script author never wrote.
 */
export interface TaskRuntime {
  readonly deadlineAfter: typeof deadlineAfter;
  readonly spawn: typeof spawn;
  readonly createScope: typeof createScope;
  readonly emit: typeof emit;
  readonly on: typeof onGenerated;
  readonly createMachine: typeof createMachine;
  /** The scope a `spawn` outside any `scope` block belongs to: this module's own. */
  readonly scope: Scope;
}

export interface DriftModule {
  /** Mutable on purpose: a hot patch writes here and every caller reads through it. */
  readonly exports: Record<string, unknown>;
  readonly info: DriftModuleInfo;
  readonly disposed: boolean;
  /**
   * The scope every task this module spawns belongs to.
   *
   * A module is the natural owner of the work its own code started, and giving it one here rather
   * than leaving a host to remember is what makes disposal complete: there is no way to tear a
   * module down and leave a task of its own running.
   */
  readonly scope: Scope;
}

const EMPTY_INFO: DriftModuleInfo = { module: '<unknown>', requires: [], shapes: {}, schemas: {} };

/**
 * Adopt a generated module namespace.
 *
 * The namespace object an `import` yields is frozen and read-only, so its contents are copied into
 * a record the runtime owns. That copy is what a patch overwrites; without it, a reload would have
 * to replace the module object itself and every holder would keep the old one.
 */
export function loadModule(namespace: Record<string, unknown>): DriftModule {
  const exports: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(namespace)) {
    if (key === '__drift') continue;
    exports[key] = value;
  }

  const info = (namespace.__drift as DriftModuleInfo | undefined) ?? EMPTY_INFO;
  const module: DriftModule = { exports, info, disposed: false, scope: createScope() };

  /*
   * A module that declares tasks is handed the scheduler here.
   *
   * **Here rather than through the host's implementation map**, because the scheduler is the
   * language's own and not a capability: a target that could decline it would be a target that
   * could decline `while`. `bindModule` stays about what an *engine* provides, and a consumer
   * never has to know that a script it loaded happened to contain a task.
   */
  const runtime = namespace.__runtime as ((r: TaskRuntime) => void) | undefined;
  if (typeof runtime === 'function') runtime(runtimeFor(module));

  return module;
}

/**
 * What each module was last bound to, so a patch can bind the new version to the same host.
 *
 * A `WeakMap` rather than a field on `DriftModule`, because a host map is the *caller's* object and
 * putting it on the module would make it part of what a consumer can read off one — a surface
 * nothing needs and everything could then depend on.
 */
const boundHosts = new WeakMap<DriftModule, Record<string, unknown>>();

/**
 * Bind a module to a host's implementations, and remember which host that was.
 *
 * **Remembering is the whole point, and its absence was a bug that survived every test.**
 * `patchModule` re-runs `__runtime` so a reloaded module's handlers are registered again — and it
 * did not re-run `__bind`, so every capability namespace in the new version was `undefined` and the
 * first call after an edit threw. Nothing caught it because the only module any test or demo ever
 * patched imported no capability at all.
 *
 * A caller could re-bind after every patch instead. That is the arrangement this replaces: a caller
 * who forgets gets `undefined is not a function` on a later frame, which is exactly the silent
 * no-op `AGENTS.md` forbids, arriving one edit later than the mistake.
 */
export function bindHost(module: DriftModule, host: Record<string, unknown>): void {
  boundHosts.set(module, host);
  const bind = module.exports.__bind as ((h: Record<string, unknown>) => void) | undefined;
  /* A module with no capability imports has no `__bind`; binding one is a no-op rather than an
     error, because a consumer should not have to know which of its scripts happen to use one. */
  if (typeof bind === 'function') bind(host);
}

/** Bind the current exports to whatever host this module was last bound to. Used by a patch. */
export function rebindHost(module: DriftModule): void {
  const host = boundHosts.get(module);
  if (host === undefined) return;
  const bind = module.exports.__bind as ((h: Record<string, unknown>) => void) | undefined;
  if (typeof bind === 'function') bind(host);
}

/**
 * The runtime a generated module is handed.
 *
 * Built per module because `scope` is the module's own, and shared with `patchModule` — which calls
 * `__runtime` again to re-register handlers, and would otherwise be a second place this object's
 * shape was written down.
 */
export function runtimeFor(module: DriftModule): TaskRuntime {
  return {
    createMachine,
    createScope,
    deadlineAfter,
    emit,
    /* Tagged as the module's, so a reload closes it and re-registers it — and leaves a host's alone. */
    on: onGenerated,
    spawn,
    scope: module.scope,
  };
}

/**
 * Release a module's exports.
 *
 * Emptying the record rather than dropping the module is what makes a stale caller fail loudly:
 * a call through a disposed module is `undefined is not a function` at the call site, rather than
 * a call into code the runtime believes it has torn down. `AGENTS.md`'s rule against silent no-ops
 * is the same rule.
 *
 * What would make this wrong is a caller that legitimately holds a module across a teardown and
 * expects it to keep working — which is what a *reload* is, and reload goes through `patchModule`
 * rather than through dispose.
 */
export function disposeModule(module: DriftModule): void {
  /* Before the exports go, so a cancellation that reached back into this module would still find
     it whole. Nothing does today; the order costs nothing and removes the question. */
  module.scope.leave();
  for (const key of Object.keys(module.exports)) delete module.exports[key];
  (module as { disposed: boolean }).disposed = true;
}

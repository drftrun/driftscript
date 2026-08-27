/**
 * Replacing a module's code while the state it operates on stays alive.
 *
 * This is what a `.drs` file is *for*: a mix tweak, a timing change, a behaviour adjustment, edited
 * and seen without restarting the scene. The engine's demo harness already runs the coarse version
 * of it — dispose, remount — and the difference here is that a scene does not restart, so a value
 * mid-animation keeps its value.
 *
 * **A patch that cannot preserve state is refused rather than applied.** Records emit as plain
 * objects, so a function swap is safe for any live instance whose *shape* is unchanged; a record
 * that gained or lost a field is a different shape, and applying a patch across one would leave
 * instances the new code reads fields from that are not there. Refusing names the record.
 *
 * **Migration is now here, and it needs the instances.** A shape change is reconciled rather than
 * refused — but only for instances the caller hands over, because the runtime does not hold any. A
 * record is a plain object a consumer keeps, which is what makes the zero-allocation constructor
 * and the shape comparison possible in the first place.
 *
 * So a shape change with no `live` argument is **refused in words** rather than applied. Applying it
 * would swap in code that reads a field the instances do not have, and the failure would surface as
 * an `undefined` in arithmetic several frames later. A caller that genuinely holds none says so by
 * passing an empty record, which is a sentence rather than an omission.
 */
import { rebindHost, runtimeFor, type DriftModule, type DriftModuleInfo } from './module.ts';
import { closeGeneratedHandlersOf } from './events.ts';
import { migrate } from './migrate.ts';
import type { Schema } from './state.ts';
import { rebindTasks } from './tasks.ts';

export type PatchResult =
  | { readonly patched: true }
  | { readonly patched: false; readonly reason: string };

/** Whether two record shapes are the same list of fields in the same order. */
function sameShape(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((name, i) => name === after[i]);
}

/**
 * Whether a record is unchanged, by schema where there is one and by field names where there is not.
 *
 * **A field-name list cannot see a type change**, and that was a real hole: `phase: f32` becoming
 * `phase: String` left `shapes` identical, so the patch applied and the new code read a string
 * where the live instance held a number. Nothing refused, nothing failed, and the value was wrong
 * from that frame on. A schema carries the type, so the comparison sees it and the migration then
 * refuses it by name.
 */
function unchanged(
  beforeShape: readonly string[],
  afterShape: readonly string[],
  beforeSchema: Schema | undefined,
  afterSchema: Schema | undefined,
): boolean {
  if (beforeSchema === undefined || afterSchema === undefined) {
    return sameShape(beforeShape, afterShape);
  }
  const key = (schema: Schema): string =>
    schema.fields.map((f) => `${f.id}|${f.name}|${f.type}`).join(',');
  return key(beforeSchema) === key(afterSchema);
}

/**
 * Replace a module's exports with a newly compiled version's.
 *
 * Order matters: every shape is compared **before** anything is written. A patch that failed
 * halfway would leave a module with some functions from the new version and some from the old,
 * which is a state no source file describes and no reader could reason about.
 */
export function patchModule(
  module: DriftModule,
  namespace: Record<string, unknown>,
  /**
   * Every instance the caller holds, by record name.
   *
   * Required only when a record's shape changed, and an empty record is the way to say "none". The
   * instances are updated **in place**, because the caller holds the reference and a replacement
   * would strand it.
   */
  live?: Readonly<Record<string, readonly object[]>>,
): PatchResult {
  if (module.disposed) {
    return { patched: false, reason: 'the module has been disposed and cannot be patched' };
  }

  const next = (namespace.__drift as DriftModuleInfo | undefined) ?? {
    module: '<unknown>',
    requires: [],
    shapes: {},
    schemas: {},
  };

  /*
   * Every migration is computed before anything is written, and each is pure. A refusal on the
   * third record must leave the first two instances exactly as they were, and the module on the
   * version its instances belong to.
   */
  const pending: { instance: Record<string, unknown>; value: Record<string, unknown> }[] = [];

  for (const [name, shape] of Object.entries(next.shapes)) {
    const before = module.info.shapes[name];
    if (before === undefined) continue;
    const from = module.info.schemas?.[name];
    const to = next.schemas?.[name];
    if (unchanged(before, shape, from, to)) continue;

    if (live === undefined) {
      return {
        patched: false,
        reason:
          `\`${name}\` changed shape from (${before.join(', ')}) to (${shape.join(', ')}). Pass ` +
          'the instances you hold to `patchModule` so they can be migrated, or an empty record if ' +
          'you hold none — the runtime does not keep them, so it cannot know.',
      };
    }

    if (from === undefined || to === undefined) {
      /* A module compiled before schemas existed. Refusing names what is missing rather than
         migrating on field *names*, which is the positional-id failure wearing another hat. */
      return {
        patched: false,
        reason:
          `\`${name}\` changed shape and one of the two versions carries no schema, so there is ` +
          'nothing to match its fields by. Recompile both with a version of the compiler that ' +
          'emits schemas.',
      };
    }

    const construct = namespace[`create${name}`];
    const defaults =
      typeof construct === 'function'
        ? (construct as () => Record<string, unknown>)()
        : ({} as Record<string, unknown>);

    for (const instance of live[name] ?? []) {
      const result = migrate(instance, from, to, defaults);
      if (!result.migrated) {
        return {
          patched: false,
          reason: `${result.reason} The module was left on its previous version.`,
        };
      }
      pending.push({ instance: instance as Record<string, unknown>, value: result.value });
    }
  }

  for (const name of Object.keys(module.info.shapes)) {
    if (next.shapes[name] === undefined) {
      return {
        patched: false,
        reason:
          `\`${name}\` no longer exists. Live instances of it would be orphaned, so the module ` +
          'was left on its previous version.',
      };
    }
  }

  for (const key of Object.keys(module.exports)) delete module.exports[key];
  for (const [key, value] of Object.entries(namespace)) {
    if (key === '__drift') continue;
    module.exports[key] = value;
  }
  (module as { info: DriftModuleInfo }).info = next;

  /*
   * In place, and the whole object is rewritten rather than the changed fields patched: a field the
   * new shape dropped has to *go*, or code that still reads it keeps working and the next reload
   * inherits a shape nothing declares.
   */
  for (const { instance, value } of pending) {
    for (const key of Object.keys(instance)) delete instance[key];
    for (const [key, field] of Object.entries(value)) instance[key] = field;
  }

  /* A live task is pointed at the new code and keeps its frame, so a task mid-way through a
     three-second wait keeps the seconds it has already waited. Nothing above this line has run,
     so a refused patch leaves every task on the version its frame belongs to. */
  rebindTasks(module.scope, module.exports);

  /*
   * Handlers are closed and registered again from the new version, rather than pointed at it.
   *
   * A handler is a function and nothing else — it has no frame to keep, which is the whole reason a
   * task needs rebinding and this does not. Re-running `__runtime` is what re-registers them, and
   * closing first is what stops a reload doubling every handler in the module.
   *
   * Only the module's own: a host listening on the same scope is not re-registered by anything, so
   * closing it would leave a page that looks alive and hears nothing.
   */
  closeGeneratedHandlersOf(module.scope);
  const runtime = module.exports.__runtime as ((r: unknown) => void) | undefined;
  if (typeof runtime === 'function') runtime(runtimeFor(module));

  /*
   * The new version's capability namespaces, bound to the host the old version was bound to.
   *
   * `__bind` assigns module-level `let`s that the patched exports close over, so a version that is
   * never bound has every namespace at `undefined` — and the first capability call after an edit
   * throws with the namespace's own name in it. That is a better failure than a silent no-op and
   * still an edit that breaks a running page.
   */
  rebindHost(module);

  return { patched: true };
}

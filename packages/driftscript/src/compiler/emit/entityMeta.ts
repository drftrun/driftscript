/**
 * Components, entities, systems and prefabs, into the module's `__drift` metadata.
 *
 * **A host reads this and builds a world from it**: a `ComponentType` per component, a `Prefab` per
 * prefab, and a `SystemDefinition` per system. Nothing here is code — it is a description, which is
 * what lets an editor or an inspector read the same bytes a runtime does.
 *
 * ---
 *
 * ## `mode` is read here, and this is the first thing that has ever read it
 *
 * `IMPROVEMENTS.md` recorded `CompileOptions.mode` as a required option that `grep` found in
 * exactly two places: its declaration and one assignment. It names the one use that would be wrong
 * to give it — stripping the integer overflow helpers, because `$chk` throws on overflow and a
 * production build without it would have **different semantics**, which this repository has no rule
 * for.
 *
 * Stripping editor metadata is the other kind. It changes payload and nothing else, and §17 of the
 * design states it as the intended behaviour in the same breath as the emission: the compiler knows
 * the metadata, an editor consumes it when present, and a shipping build carries no editor runtime
 * and may drop it entirely.
 *
 * **The line that keeps that true is that nothing at runtime may read editor metadata for anything
 * but inspection.** The moment something does, the two modes stop agreeing about what a program
 * means — which is the thing `IMPROVEMENTS.md` is actually warning about. A test asserts it.
 */
import type { IrComponent, IrEntity, IrPrefab, IrSystem } from '../ir/ir.ts';
import { schemaOf } from '../schema/schema.ts';

export interface EntityMetadata {
  readonly components: readonly {
    readonly name: string;
    readonly fromHost: boolean;
    readonly schema: ReturnType<typeof schemaOf>;
    readonly editor?: Readonly<Record<string, unknown>>;
  }[];
  readonly entities: readonly {
    readonly name: string;
    readonly requires: readonly string[];
    readonly ownComponent: string | null;
  }[];
  readonly systems: readonly {
    readonly name: string;
    readonly reads: readonly string[];
    readonly writes: readonly string[];
    readonly after: readonly string[];
    readonly everyTicks: number;
  }[];
  readonly prefabs: readonly {
    readonly name: string;
    readonly components: readonly {
      readonly name: string;
      readonly values: Readonly<Record<string, number | string | boolean>>;
    }[];
  }[];
}

/**
 * The metadata a host reads, with editor metadata included only in development.
 *
 * The four lists are always present even when empty, so a host reads a field rather than testing
 * for one — a module with no components still says so.
 */
export function entityMetadata(
  ir: {
    readonly components: readonly IrComponent[];
    readonly entities: readonly IrEntity[];
    readonly systems: readonly IrSystem[];
    readonly prefabs: readonly IrPrefab[];
  },
  mode: 'development' | 'production',
): EntityMetadata {
  return {
    components: ir.components.map((component) => {
      /* `schemaOf` takes an `IrData`; a component is shaped like one so the field ids come from the
         same code that builds a record's, rather than a second implementation that agrees today. */
      const schema = schemaOf({
        name: component.name,
        fields: component.fields,
        span: component.span,
      });
      const editor = Object.keys(component.editor).length === 0 ? undefined : component.editor;
      return {
        name: component.name,
        fromHost: component.fromHost,
        schema,
        /* Absent in production, and absent rather than empty: an empty object in every component of
           every shipped module is bytes describing nothing. */
        ...(mode === 'development' && editor !== undefined ? { editor } : {}),
      };
    }),
    entities: ir.entities.map((entity) => ({
      name: entity.name,
      requires: entity.requires,
      ownComponent: entity.ownComponent,
    })),
    systems: ir.systems.map((system) => ({
      name: system.name,
      reads: system.reads,
      writes: system.writes,
      after: system.after,
      everyTicks: system.everyTicks,
    })),
    prefabs: ir.prefabs.map((prefab) => ({
      name: prefab.name,
      components: prefab.components,
    })),
  };
}

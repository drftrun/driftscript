/**
 * What each module publishes, and the scope a module that imports it gets.
 *
 * **Every module's declarations are resolved in its own scope, then imported already-resolved.** The
 * alternative — handing an importing file the *syntax* of a record and letting it resolve the field
 * types — cannot work: an imported record's fields may name types from its own module that the
 * importing file never imported, and resolving them there would need a scope it does not have. The
 * module that owns a declaration is the only place that can resolve it.
 *
 * **Bodies are never checked here.** A module publishes names, field types and signatures; that is
 * what a dependent needs and all of it. Checking bodies would check every reachable file on every
 * keystroke in a leaf, and would report a dependency's errors against the file that imported it.
 */
import type { Diagnostic } from '../diagnostics.ts';
import type { ImportedScope } from '../check/checker.ts';
import { collect } from '../check/checker.ts';
import type { IrField } from '../ir/ir.ts';
import { lowerRecords } from '../ir/lower.ts';
import type { GraphModule, ResolvedGraph } from './graph.ts';

/** An empty scope, for a module that imports nothing. Shared, because it is never written to. */
const EMPTY: ImportedScope = {
  data: new Map(),
  enums: new Map(),
  functions: new Map(),
  constants: new Map(),
};

/** What a module publishes: its declarations, and its records already lowered. */
interface Published {
  readonly scope: ImportedScope;
  /**
   * Each record's fields, in layout order, with their default expressions lowered.
   *
   * **Lowered here rather than by whoever imports it**, because a default expression can only be
   * lowered by the file that declared it — that is where its type was checked. A subtype in another
   * file inlines these directly, which is what lets `createWolf` be one object literal carrying
   * values written in `dog.drs`.
   */
  readonly records: ReadonlyMap<string, readonly IrField[]>;
  /**
   * Every capability module this one needs, its own and its imports', transitively.
   *
   * A target that linked a file without these could link it and then fail at runtime inside a module
   * it never looked at, which is the linker declining to answer the question it exists for.
   */
  readonly requires: readonly string[];
  /**
   * For a requirement this module did not import directly, the file specifier that pulled it in.
   *
   * Only the *first* specifier that brings one in is recorded. A capability reachable by two paths
   * needs one of them named, not both — a reader follows the first and finds the same requirement.
   */
  readonly through: ReadonlyMap<string, string>;
}

const NOTHING: Published = {
  scope: EMPTY,
  records: new Map(),
  requires: [],
  through: new Map(),
};

/**
 * Resolve every module in the graph, dependencies first.
 *
 * Depth-first with a `visiting` set. A module reached while it is still being resolved is a cycle,
 * and it contributes whatever it has resolved so far rather than recursing — which terminates, and
 * which matches the order-sensitivity the language already has *within* a file: a record referring
 * to one declared after it does not resolve there either. Making cycles order-independent across
 * files while they are order-dependent inside one would be a rule nobody could hold in their head.
 */
export function interfacesOf(graph: ResolvedGraph): ReadonlyMap<string, Published> {
  const resolved = new Map<string, Published>();
  const visiting = new Set<string>();

  const resolve = (id: string): Published => {
    const done = resolved.get(id);
    if (done !== undefined) return done;

    const module = graph.modules.get(id);
    if (module === undefined || visiting.has(id)) return NOTHING;

    visiting.add(id);
    const from = scopeFor(module, resolve);
    const own = collect(module.module, id, from.scope);
    visiting.delete(id);

    const published: Published = {
      scope: {
        data: own.data,
        enums: own.enums,
        functions: own.functions,
        constants: own.constants,
      },
      records: lowerRecords(
        module.module,
        {
          types: own.types,
          data: own.data,
          enums: own.enums,
          functions: own.functions,
          constants: own.constants,
          /* Empty: this lowers a dependency's *records* for their defaults, and a record has no
             query loops and no component access. Passing the collect pass's own would mean
             threading state through a path that never reads it. */
          queries: new Map(),
          access: new Map(),
          rounded: new Set(),
          componentWorlds: new Map(),
          rowFields: new Map(),
          diagnostics: [],
        },
        from.records,
        id,
      ),
      requires: from.requires,
      through: from.through,
    };
    resolved.set(id, published);
    return published;
  };

  for (const id of graph.modules.keys()) resolve(id);
  return resolved;
}

/**
 * The scope a module's own imports give it, and a refusal for each name that is not there.
 *
 * `resolve` is passed in rather than looked up so this serves both passes: building the interfaces,
 * where a dependency may still be resolving, and building the root's scope, where everything is.
 */
function scopeFor(
  module: GraphModule,
  resolve: (id: string) => Published,
): {
  scope: ImportedScope;
  records: ReadonlyMap<string, readonly IrField[]>;
  requires: readonly string[];
  through: ReadonlyMap<string, string>;
  diagnostics: Diagnostic[];
} {
  const data = new Map<string, ReturnType<typeof Map.prototype.get>>();
  const enums = new Map<string, ReturnType<typeof Map.prototype.get>>();
  const functions = new Map<string, ReturnType<typeof Map.prototype.get>>();
  const constants = new Map<string, ReturnType<typeof Map.prototype.get>>();
  const records = new Map<string, readonly IrField[]>();
  const diagnostics: Diagnostic[] = [];

  /* This module's own capability imports come first, so a direct requirement is never recorded as
     reached "through" an import — the clause is only informative where a reader cannot see it. */
  const requires: string[] = [];
  const through = new Map<string, string>();
  for (const decl of module.module.imports) {
    if (!decl.relative && !requires.includes(decl.module)) requires.push(decl.module);
  }

  for (const decl of module.module.imports) {
    if (!decl.relative) continue;

    const from = module.imports.find((i) => i.specifier === decl.module);
    if (from === undefined) continue;
    const dependency = resolve(from.id);
    const published = dependency.scope;
    const lowered = dependency.records;

    for (const required of dependency.requires) {
      if (requires.includes(required)) continue;
      requires.push(required);
      through.set(required, decl.module);
    }

    for (const name of decl.names) {
      const type = published.data.get(name);
      const enumeration = published.enums.get(name);
      const fn = published.functions.get(name);
      const constant = published.constants.get(name);
      const fields = lowered.get(name);
      if (fields !== undefined) records.set(name, fields);

      if (type !== undefined) data.set(name, type);
      else if (enumeration !== undefined) enums.set(name, enumeration);
      else if (fn !== undefined) functions.set(name, fn);
      else if (constant !== undefined) constants.set(name, constant);
      else {
        diagnostics.push({
          code: 'DS0502',
          severity: 'error',
          message:
            `\`${name}\` is not declared by \`${decl.module}\`.` + suggestion(name, published),
          file: module.id,
          ...decl.span,
        });
      }
    }
  }

  return {
    scope: { data, enums, functions, constants } as ImportedScope,
    records,
    requires,
    through,
    diagnostics,
  };
}

/**
 * The nearest name that module does declare, when there is one close enough.
 *
 * A wrong import is almost always a typo or a rename that missed a file, so the name a person meant
 * is usually one edit away. Naming it is the difference between a diagnostic somebody acts on and
 * one they go and open another file for. Two edits is the ceiling: past that the suggestion is a
 * guess, and a confident wrong guess costs more than none.
 */
function suggestion(name: string, published: ImportedScope): string {
  let best: string | null = null;
  let bestDistance = 3;

  for (const candidate of [
    ...published.data.keys(),
    ...published.enums.keys(),
    ...published.functions.keys(),
    ...published.constants.keys(),
  ]) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best === null ? '' : ` Did you mean \`${best}\`?`;
}

/** Levenshtein, two rows rather than a matrix. Called once per failed import, never in a loop. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length];
}

/**
 * The scope for one module, with the refusals its own import list earns.
 *
 * This is what `compileDriftScript` hands the checker for the file it was asked about.
 */
export function importedScope(
  graph: ResolvedGraph,
  id: string,
): {
  scope: ImportedScope;
  records: ReadonlyMap<string, readonly IrField[]>;
  requires: readonly string[];
  through: ReadonlyMap<string, string>;
  diagnostics: readonly Diagnostic[];
} {
  const module = graph.modules.get(id);
  if (module === undefined) {
    return { scope: EMPTY, records: new Map(), requires: [], through: new Map(), diagnostics: [] };
  }

  const interfaces = interfacesOf(graph);
  return scopeFor(module, (other) => interfaces.get(other) ?? NOTHING);
}

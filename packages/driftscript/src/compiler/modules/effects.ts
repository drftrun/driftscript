/**
 * What every function in the graph does, settled across module boundaries.
 *
 * **An effect reached through an import is still that effect.** Inference that stopped at a file
 * boundary would make `@deterministic` mean "calls nothing impure *in this file*" — and the day
 * somebody moved one call into a helper module, the annotation would start passing for a function
 * that plays audio. Nothing would fail; the guarantee would just quietly stop being one.
 *
 * **A cycle is why this is a fixed point rather than a walk.** When `a.drs` calls into `b.drs` and
 * `b.drs` calls back, neither module's effect set is final until both stop changing, and there is no
 * order that gets it right in one pass. Rounds terminate because a set only ever grows and there are
 * finitely many effects and functions.
 *
 * **The inference itself is not re-implemented here.** `checkEffects` is called per module, round
 * after round, with what the previous round settled — so there is one implementation of what an
 * effect is and this file only decides when to stop. Two implementations of that decision would
 * drift, and the drift would be an annotation that means different things in different files.
 */
import type { FnDecl } from '../ast.ts';
import { checkEffects } from '../check/effects.ts';
import type { CapabilityRegistry, Effect } from '../../registry/capability.ts';
import type { ResolvedGraph } from './graph.ts';

/** Module id to the effects of each function it declares. */
export type GraphEffects = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<Effect>>>;

const NONE: ReadonlyMap<string, ReadonlySet<Effect>> = new Map();

/**
 * The effects each module's functions have, once nothing more can be added.
 *
 * The bound is deliberate and generous: every round must add at least one effect to at least one
 * function or the loop ends, so the true worst case is (functions × effects) rounds. The cap exists
 * so a bug in that reasoning is a wrong answer rather than a hung editor — a language server that
 * stops responding to a keystroke looks like a crash, and a crash is the one failure a person cannot
 * work around.
 */
export function effectsAcross(graph: ResolvedGraph, registry: CapabilityRegistry): GraphEffects {
  const settled = new Map<string, ReadonlyMap<string, ReadonlySet<Effect>>>();
  for (const id of graph.modules.keys()) settled.set(id, NONE);

  const rounds = graph.modules.size * 8 + 8;
  for (let round = 0; round < rounds; round += 1) {
    let grew = false;

    for (const [id, module] of graph.modules) {
      const before = settled.get(id) ?? NONE;
      const { effects } = checkEffects(module.module, registry, id, importedFor(graph, settled, id));

      /* Only this module's own functions are recorded. `checkEffects` also returns the imported
         names it was seeded with, and carrying those forward would make one module appear to
         declare another's functions. */
      const own = new Map<string, ReadonlySet<Effect>>();
      for (const decl of module.module.decls) {
        if (decl.kind !== 'fn') continue;
        own.set(decl.name, effects.get((decl as FnDecl).name) ?? new Set());
      }

      if (!same(before, own)) grew = true;
      settled.set(id, own);
    }

    if (!grew) return settled;
  }

  return settled;
}

/**
 * What one module's imports contribute, keyed by the local name each was imported as.
 *
 * The local name rather than the declaring one, because that is what a call site writes and what
 * `checkEffects` looks up. An import that renamed something would be indexed here under the name
 * the importing file actually uses.
 */
export function importedFor(
  graph: ResolvedGraph,
  settled: GraphEffects,
  id: string,
): ReadonlyMap<string, ReadonlySet<Effect>> {
  const module = graph.modules.get(id);
  if (module === undefined) return NONE;

  const out = new Map<string, ReadonlySet<Effect>>();
  for (const decl of module.module.imports) {
    if (!decl.relative) continue;
    const resolved = module.imports.find((i) => i.specifier === decl.module);
    if (resolved === undefined) continue;
    const published = settled.get(resolved.id) ?? NONE;
    for (const name of decl.names) {
      const effects = published.get(name);
      if (effects !== undefined) out.set(name, effects);
    }
  }
  return out;
}

function same(
  a: ReadonlyMap<string, ReadonlySet<Effect>>,
  b: ReadonlyMap<string, ReadonlySet<Effect>>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [name, mine] of a) {
    const theirs = b.get(name);
    if (theirs === undefined || theirs.size !== mine.size) return false;
    for (const effect of mine) if (!theirs.has(effect)) return false;
  }
  return true;
}

/**
 * Every module reachable from a root, and which of them have to be checked together.
 *
 * **A module cycle is allowed. An inheritance cycle is not.** Those are two different graphs with
 * opposite rules, and conflating them fails in both directions: forbidding module cycles makes
 * mutually-referring behaviour files impossible to write, and permitting inheritance cycles makes
 * the layout pass diverge instead of reporting anything. This file finds module cycles; it does not
 * refuse them. The checker refuses inheritance cycles.
 *
 * **Why a module cycle is safe here is a property of the emitter, not a law.** A generated module
 * has no top-level state: `let` bindings assigned by `__bind`, hoisted function declarations,
 * frozen enum literals and a JSON metadata constant. Record defaults run inside `createX()` at call
 * time, and the language has no top-level `let` at all. So nothing in a half-initialised module can
 * be read during evaluation. That is asserted by a test over the emitter rather than trusted here,
 * because it would otherwise break silently the day somebody emits a top-level expression.
 *
 * **Components come from Tarjan's algorithm.** It is forty lines, has no dependency, and answers
 * exactly the question asked: which modules cannot be finished before each other, and therefore
 * have to have their declarations collected as a set. The alternative — checking each module alone
 * and hoping the order works out — has no correct order when there is a cycle.
 */
import type { Span } from '../ast.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Module } from '../ast.ts';
import { parse } from '../parser.ts';
import type { ModuleHost } from './host.ts';

export interface ResolvedImport {
  /** As written in the source, for a diagnostic a reader can match to what they typed. */
  readonly specifier: string;
  /** What the host resolved it to. */
  readonly id: string;
  readonly span: Span;
}

export interface GraphModule {
  readonly id: string;
  readonly source: string;
  readonly module: Module;
  /** Only the file imports, resolved. A capability import never reaches a host. */
  readonly imports: readonly ResolvedImport[];
}

export interface ResolvedGraph {
  /** Every module reachable from the root, keyed by resolved id, the root included. */
  readonly modules: ReadonlyMap<string, GraphModule>;
  /** The root's strongly-connected component — the set whose declarations are collected together. */
  readonly component: readonly string[];
  /** A specifier that did not resolve, a file that did not load, or a file that did not parse. */
  readonly diagnostics: readonly Diagnostic[];
}

export function resolveGraph(
  rootId: string,
  rootSource: string,
  host: ModuleHost,
): ResolvedGraph {
  const modules = new Map<string, GraphModule>();
  const diagnostics: Diagnostic[] = [];

  const refuse = (code: Diagnostic['code'], message: string, file: string, span: Span): void => {
    diagnostics.push({ code, severity: 'error', message, file, ...span });
  };

  /*
   * Breadth-first, with the visited set keyed on the resolved id.
   *
   * Recursion would be the shorter write and does not terminate on a cycle, which is the one thing
   * this graph is allowed to contain.
   */
  const queue: { id: string; source: string }[] = [{ id: rootId, source: rootSource }];

  while (queue.length > 0) {
    const { id, source } = queue.shift() as { id: string; source: string };
    if (modules.has(id)) continue;

    const parsed = parse(source, id);
    const imports: ResolvedImport[] = [];

    for (const decl of parsed.module.imports) {
      if (!decl.relative) continue;

      const resolved = host.resolve(decl.module, id);
      if (resolved === null) {
        /*
         * One message for two situations, told apart by the host rather than here.
         *
         * `singleFileHost` resolves nothing, so its refusal has to read *this compile has no module
         * host* and a filesystem host's has to read *no such file*. Both are `DS0501`, because both
         * are the same failure to a reader — the import does not lead anywhere — and a second code
         * would split a consumer's grep for no gain.
         */
        refuse(
          'DS0501',
          `\`${decl.module}\` does not resolve. Either the file is not there, or this compile has ` +
            'no module host configured.',
          id,
          decl.span,
        );
        continue;
      }

      imports.push({ specifier: decl.module, id: resolved, span: decl.span });

      if (modules.has(resolved) || queue.some((q) => q.id === resolved)) continue;

      const loaded = host.load(resolved);
      if (loaded === null) {
        refuse('DS0501', `\`${decl.module}\` resolved to \`${resolved}\`, which could not be read.`, id, decl.span);
        continue;
      }

      /*
       * A file that does not parse is reported **at the import, in the importing file**.
       *
       * Its own errors are reported when it is compiled; repeating them here would send somebody to
       * fix them in the wrong file. What the importing file needs to know is only that the names it
       * asked for are unknown, which is one diagnostic rather than a cascade about each name.
       */
      const dependency = parse(loaded, resolved);
      if (dependency.diagnostics.some((d) => d.severity === 'error')) {
        refuse(
          'DS0506',
          `\`${decl.module}\` could not be parsed, so the names it declares are unknown here. ` +
            `Fix \`${resolved}\` first.`,
          id,
          decl.span,
        );
        continue;
      }

      queue.push({ id: resolved, source: loaded });
    }

    modules.set(id, { id, source, module: parsed.module, imports });
  }

  return { modules, component: componentOf(rootId, modules), diagnostics };
}

/**
 * The strongly-connected component containing `root`, by Tarjan's algorithm.
 *
 * Iterative rather than recursive, because the recursion depth is the depth of the import graph and
 * a deep one would be a stack overflow reported as a crash rather than as anything about modules.
 *
 * A module in no cycle comes back as a component of one, so callers have a single rule rather than
 * a special case: collect the component, whatever its size.
 */
function componentOf(root: string, modules: ReadonlyMap<string, GraphModule>): readonly string[] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  let found: string[] | null = null;

  /** The explicit work stack: a node, and how many of its edges have been walked. */
  const work: { id: string; edge: number }[] = [{ id: root, edge: 0 }];
  index.set(root, counter);
  low.set(root, counter);
  counter += 1;
  stack.push(root);
  onStack.add(root);

  while (work.length > 0) {
    const frame = work[work.length - 1];
    const edges = modules.get(frame.id)?.imports ?? [];

    if (frame.edge < edges.length) {
      const next = edges[frame.edge].id;
      frame.edge += 1;

      if (!index.has(next)) {
        if (!modules.has(next)) continue;
        index.set(next, counter);
        low.set(next, counter);
        counter += 1;
        stack.push(next);
        onStack.add(next);
        work.push({ id: next, edge: 0 });
      } else if (onStack.has(next)) {
        low.set(frame.id, Math.min(low.get(frame.id) ?? 0, index.get(next) ?? 0));
      }
      continue;
    }

    work.pop();
    const parent = work[work.length - 1];
    if (parent !== undefined) {
      low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0));
    }

    if (low.get(frame.id) === index.get(frame.id)) {
      const members: string[] = [];
      for (;;) {
        const member = stack.pop() as string;
        onStack.delete(member);
        members.push(member);
        if (member === frame.id) break;
      }
      if (members.includes(root)) found = members;
    }
  }

  return found ?? [root];
}

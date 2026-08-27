/**
 * What has to be recompiled after an edit, and nothing more.
 *
 * An editor asks constantly and the compiler is a batch compiler. The interface hash is what makes
 * the difference between the two survivable: a body edit leaves it identical, so nothing that
 * depends on the edited module can be affected and nothing downstream is touched; a signature or a
 * record change moves it, so everything downstream is.
 *
 * **The dependency graph is supplied rather than derived**, and that is the load-bearing decision
 * here. Today a DriftScript module imports capability modules and never another `.drs` file, so a
 * workspace of open documents has no edges at all and this schedules exactly the file that changed
 * — which is correct, not a stub. The graph that is real today is the *bundler's*: a `.ts` file
 * importing a `.drs` module is a dependent, and the Vite plugin supplies it from Vite's own module
 * graph. What would make this wrong is nothing; what would make it *more* than it is today is the
 * language growing file imports, at which point the edges arrive from
 * `CompileResult.metadata.imports` and this file does not change.
 *
 * The retention across a failed compile lives in `InterfaceLedger`, in `driftscript`, because the
 * Vite plugin needs exactly the same decision and two implementations of one decision drift.
 */
import { type InterfaceLedger, createInterfaceLedger } from 'driftscript/compiler';

export interface ScheduleWorkspace {
  /**
   * The modules that depend on this one, directly.
   *
   * Transitive dependents are reached by walking, not by asking — a dependent is only carried
   * further when its *own* interface also moved, which is what stops one edit from rebuilding a
   * project.
   */
  dependentsOf(module: string): readonly string[];
  /**
   * The module's interface as it compiles right now, or `undefined` when it does not compile.
   *
   * `undefined` is not an error to report here. It is the ordinary state of a file somebody is
   * part-way through typing, and the ledger is what keeps it from being read as a change.
   */
  interfaceOf(module: string): string | undefined;
}

export interface Schedule {
  /** The modules to recompile, the changed one first, each appearing once. */
  readonly recompile: readonly string[];
}

export interface Scheduler {
  schedule(changed: string): Schedule;
  /** Drop a module, for a document that was closed or a file that was deleted. */
  forget(module: string): void;
}

export function createScheduler(workspace: ScheduleWorkspace): Scheduler {
  const ledger: InterfaceLedger = createInterfaceLedger();

  return {
    schedule(changed) {
      const recompile: string[] = [];
      const seen = new Set<string>();
      /*
       * A queue rather than recursion, and a visited set rather than a depth limit.
       *
       * Two modules that depend on each other are a cycle in this graph, and a walk without the set
       * does not terminate on one. A language server that hangs on a keystroke is a worse failure
       * than one that rebuilds too much, because the second is slow and the first looks like a
       * crash. What would make the set unnecessary is a graph proven acyclic, which a bundler's
       * import graph is not.
       */
      const queue: string[] = [changed];

      while (queue.length > 0) {
        const module = queue.shift() as string;
        if (seen.has(module)) continue;
        seen.add(module);
        recompile.push(module);

        /* Recorded for every module reached, not only for the one that changed: a dependent's own
           interface decides whether the walk carries past it, and that is the whole reason this
           terminates short of the project. */
        if (ledger.record(module, workspace.interfaceOf(module)).moved) {
          queue.push(...workspace.dependentsOf(module));
        }
      }

      return { recompile };
    },

    forget(module) {
      ledger.forget(module);
    },
  };
}

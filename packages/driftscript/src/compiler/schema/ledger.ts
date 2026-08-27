/**
 * What each module's interface was the last time it compiled, and whether the latest compile moved
 * it.
 *
 * `interfaceHash` answers "what is this module's interface now". Deciding whether anything
 * downstream has to be rebuilt needs a second thing — what it was before — and that is a small
 * amount of state two very different callers both need. The language server schedules a recompile
 * on it; the Vite plugin decides on it whether an edit may be hot-patched into a running page or
 * has to take the importers with it.
 *
 * **It lives here, in one implementation, because two would drift.** They would drift silently and
 * in the worst direction: the build and the editor would disagree about whether an edit was
 * breaking, which is the same failure the language service exists to prevent one layer up. The cost
 * is that `driftscript` now carries a mutable object where everything else in the compiler is a
 * pure function of its input, and it is confined to this file for that reason. What would make it
 * wrong is a caller wanting the comparison without the memory — which is `interfaceHash` itself,
 * still exported and still pure.
 *
 * **A compile that failed does not overwrite what is remembered**, and that clause is the whole
 * reason this is not a `Map` at each call site. See `record`.
 */

export interface InterfaceMove {
  /** Whether what a dependent may depend on differs from the last time this module compiled. */
  readonly moved: boolean;
  /**
   * The interface this module is now known by.
   *
   * The last good one when the current source does not compile, and `''` when it has never
   * compiled at all — which is honest in both directions: there is nothing to be known by.
   */
  readonly interfaceHash: string;
}

export interface InterfaceLedger {
  /**
   * Record what a module just compiled to, and say whether that moved its interface.
   *
   * `interfaceHash` is `undefined` or `''` when the compile failed. `CompileResult` carries `''`
   * rather than omitting the field, so both spellings mean the same thing here and a caller
   * forwarding `result.metadata.interfaceHash` straight through needs no guard of its own.
   */
  record(module: string, interfaceHash: string | undefined): InterfaceMove;
  /** The last interface a module compiled to, or `undefined` if it never has. */
  lastGood(module: string): string | undefined;
  /** Drop a module, for a file that was deleted or a document that was closed. */
  forget(module: string): void;
}

export function createInterfaceLedger(): InterfaceLedger {
  const good = new Map<string, string>();

  return {
    record(module, interfaceHash) {
      /*
       * A failed compile leaves the ledger exactly as it was.
       *
       * Both of the obvious alternatives are wrong, and they are wrong in different ways. Reading
       * "no interface" as a *move* rebuilds every dependent on every keystroke that leaves a file
       * half-typed, which in an editor is most keystrokes — slow, but at least not incorrect.
       * Recording the empty hash is the one that gives a wrong answer: the next compile that
       * succeeds then compares against nothing, so an interface edited while the file was
       * unparseable is either missed or forces a full rebuild, and which of the two it is depends
       * on how the caller happens to treat an unknown module.
       *
       * The cost of retaining it is that a module's dependents are stale for as long as it does not
       * compile. That is correct rather than tolerated: a module that does not compile emits no
       * code, so there is nothing for a dependent to be stale against.
       */
      if (interfaceHash === undefined || interfaceHash === '') {
        return { moved: false, interfaceHash: good.get(module) ?? '' };
      }

      const before = good.get(module);
      good.set(module, interfaceHash);
      /* First sight is a move. Nothing downstream was built against this module, so the safe
         direction is the one that rebuilds — and it is taken once per module per process. */
      return { moved: before !== interfaceHash, interfaceHash };
    },

    lastGood: (module) => good.get(module),

    forget(module) {
      good.delete(module);
    },
  };
}

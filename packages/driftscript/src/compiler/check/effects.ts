/**
 * What a function does besides compute, and what `@deterministic` is allowed to mean.
 *
 * **This is not a second notion of determinism.** The host engine already draws the line: nothing on
 * a path a consumer might simulate reads a wall clock, reads entropy, or reaches a host; input
 * *sampling* reads the clock and intents cross the boundary as data. That sentence is the effect
 * system, and this file makes the compiler enforce mechanically what review enforced before.
 *
 * **Effects are inferred, not declared.** `@pure`, `@deterministic` and `@hot` are assertions the
 * checker verifies rather than information it needs — a function calling something effectful *has*
 * that effect whether or not anybody wrote it down. Annotations exist so a mistake is caught at the
 * function that claimed something, rather than at the call site three files away that relied on it.
 *
 * **An effect enters a program at a capability call and nowhere else.** That is what makes
 * inference possible at all, and it is why the registry declares effects: pure computation over
 * local values cannot acquire one.
 *
 * An effect is a property of the code; *availability* is a property of the target. A function that
 * writes audio has `audio.write` whether or not this target links audio, which is what lets a `.drs`
 * file be checked against capabilities that have not shipped.
 */
import type { FnDecl, Expr, Module, Span, Stmt } from '../ast.ts';
import type { Diagnostic, DiagnosticCode } from '../diagnostics.ts';
import type { CapabilityRegistry, Effect } from '../../registry/capability.ts';
import { DETERMINISTIC_EFFECTS } from '../../registry/capability.ts';

export interface EffectResult {
  /** Every effect each function has, after propagation through the call graph. */
  readonly effects: ReadonlyMap<string, ReadonlySet<Effect>>;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The boundary, **imported rather than restated**.
 *
 * There were two copies of this set — one here and one in `registry/capability.ts`, which refuses a
 * capability that claims a determinism it does not have. Two descriptions of one boundary is the
 * drift this repository has a rule about, and it drifted the first time either moved: `ecs.write`
 * was added to the registry's copy when the entity model shipped, every capability registered
 * correctly, and
 * the checker went on refusing every `@deterministic` function that wrote entity state.
 */

/** The annotations this file understands. Others are left to whatever else reads them. */
const KNOWN = new Set(['pure', 'deterministic', 'hot']);

/** Which imported name came from which module, so a call can be attributed to a capability. */
function importedNames(module: Module): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const decl of module.imports) {
    for (const name of decl.names) names.set(name, decl.module);
  }
  return names;
}

/**
 * A statement kind this walk does not handle, refused at compile time.
 *
 * A function rather than an inline `const _: never = stmt`, so the error names this file and the
 * reason rather than a variable nobody assigned.
 */
function assertWalked(stmt: never): void {
  throw new Error(
    `effect inference does not walk \`${(stmt as { kind: string }).kind}\`, so every call inside ` +
      'one is invisible to it. Add a case above.',
  );
}

/** Every function this one calls, by name, including capability calls. */
function calleesOf(decl: FnDecl): ReadonlySet<string> {
  const names = new Set<string>();

  const fromExpr = (expr: Expr): void => {
    switch (expr.kind) {
      case 'call':
        if (expr.callee.kind === 'ident') names.add(expr.callee.name);
        else if (expr.callee.kind === 'member' && expr.callee.target.kind === 'ident') {
          /* `audio.play(…)` is a capability call: the module is the target, the name is the
             member. Recorded dotted so the registry lookup does not have to guess. */
          names.add(`${expr.callee.target.name}.${expr.callee.name}`);
        }
        for (const arg of expr.args) fromExpr(arg);
        return;
      case 'member':
      case 'optionalMember':
        fromExpr(expr.target);
        return;
      case 'unary':
        fromExpr(expr.operand);
        return;
      case 'binary':
        fromExpr(expr.left);
        fromExpr(expr.right);
        return;
      case 'record':
        for (const field of expr.fields) fromExpr(field.value);
        return;
      case 'try':
        fromExpr(expr.inner);
        return;
      case 'match':
        fromExpr(expr.subject);
        for (const arm of expr.arms) fromExpr(arm.body);
        return;
      default:
        return;
    }
  };

  const fromStmt = (stmt: Stmt): void => {
    switch (stmt.kind) {
      case 'let':
        fromExpr(stmt.value);
        return;
      case 'assign':
      case 'compoundAssign':
        fromExpr(stmt.target);
        fromExpr(stmt.value);
        return;
      case 'return':
        if (stmt.value !== undefined) fromExpr(stmt.value);
        return;
      case 'expr':
        fromExpr(stmt.expr);
        return;
      case 'if':
        fromExpr(stmt.condition);
        stmt.then.forEach(fromStmt);
        stmt.otherwise?.forEach(fromStmt);
        return;
      case 'ifLet':
        fromExpr(stmt.subject);
        stmt.then.forEach(fromStmt);
        stmt.otherwise?.forEach(fromStmt);
        return;
      case 'while':
        fromExpr(stmt.condition);
        stmt.body.forEach(fromStmt);
        return;
      case 'forQuery':
        /* A query names components rather than calling anything, so only the body carries calls. */
        stmt.body.forEach(fromStmt);
        return;
      case 'emit':
        /* An event's field values are ordinary expressions, and a call in one was invisible. */
        for (const field of stmt.fields) fromExpr(field.value);
        return;
      case 'spawn':
      case 'awaitTask':
        /* The task's own effects are not this function's; the arguments it is handed are. */
        stmt.args.forEach(fromExpr);
        return;
      case 'await':
        fromExpr(stmt.duration);
        return;
      case 'scope':
        stmt.body.forEach(fromStmt);
        return;
      case 'become':
        /* A state name and nothing else. There is no expression here to walk. */
        return;
      default:
        /*
         * **Exhaustive on purpose, and this switch was not.**
         *
         * It named seven statement kinds and had no `default`, so a kind it did not name was
         * skipped in silence — and a skipped statement means every call inside it is invisible to
         * inference. When the query loop landed, `@deterministic` would have passed for a function
         * playing audio, as long as the call sat inside a `for`. Nothing failed; that is the whole
         * problem with a walk that can quietly not walk.
         *
         * `never` makes the next statement kind a compile error here instead.
         */
        assertWalked(stmt);
        return;
    }
  };

  decl.body.forEach(fromStmt);
  return names;
}

/**
 * Infer every function's effects, then check the annotations against them.
 *
 * Inference runs to a fixed point rather than in one pass, because effects propagate through calls
 * and a function may call one declared below it. The iteration is bounded by the number of
 * functions: each round can only add effects, and there are finitely many.
 */
export function checkEffects(
  module: Module,
  registry: CapabilityRegistry,
  file: string,
  /**
   * What each imported function does, keyed by the local name it was imported as.
   *
   * **An effect reached through an import is still that effect.** An inference that stopped at the
   * file boundary would make `@deterministic` mean "calls nothing impure *in this file*", which is
   * not a guarantee anybody could use — and the day a behaviour script moved one call into a helper
   * module, the annotation would start passing for a function that plays audio.
   *
   * Supplied rather than inferred here because the answer for a cycle is not a property of one
   * module: `modules/effects.ts` runs this over every module until nothing grows.
   */
  importedEffects: ReadonlyMap<string, ReadonlySet<Effect>> = new Map(),
): EffectResult {
  const diagnostics: Diagnostic[] = [];
  const report = (code: DiagnosticCode, message: string, span: Span): void => {
    diagnostics.push({ code, severity: 'error', message, file, ...span });
  };

  const imported = importedNames(module);
  const fns = module.decls.filter((d): d is FnDecl => d.kind === 'fn');
  const callees = new Map<string, ReadonlySet<string>>();
  const effects = new Map<string, Set<Effect>>();

  /* The capability each call reaches, so a diagnostic can name it rather than only its effect. */
  const capabilityOf = new Map<string, { effect: Effect; label: string }[]>();

  for (const fn of fns) {
    const names = calleesOf(fn);
    callees.set(fn.name, names);
    effects.set(fn.name, new Set());

    const reached: { effect: Effect; label: string }[] = [];
    for (const name of names) {
      const dot = name.indexOf('.');
      if (dot < 0) continue;
      const alias = name.slice(0, dot);
      const member = name.slice(dot + 1);
      const module_ = imported.get(alias) ?? (alias.includes('/') ? alias : `drift/${alias}`);
      const definition = registry.get(module_, member);
      if (definition === undefined) continue;
      for (const effect of definition.effects) {
        reached.push({ effect, label: `${module_}.${member}` });
      }
    }
    capabilityOf.set(fn.name, reached);
    for (const { effect } of reached) effects.get(fn.name)?.add(effect);
  }

  /*
   * An imported function seeds the map under its local name, so the propagation below reaches it
   * exactly as it reaches a local one. Its own set never grows here — it was settled where it was
   * declared, and treating it as open would let this file's calls appear to give another file's
   * function an effect it does not have.
   */
  for (const [name, set] of importedEffects) {
    if (effects.has(name)) continue;
    effects.set(name, new Set(set));
  }

  /* Propagate to a fixed point. Bounded: each round only adds, and the set is finite. */
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of fns) {
      const mine = effects.get(fn.name);
      if (mine === undefined) continue;
      for (const callee of callees.get(fn.name) ?? []) {
        /* Only local functions are re-derived; an imported one contributes the settled set seeded
           above. Without this guard a local name shadowing an import would read the wrong one. */
        for (const effect of effects.get(callee) ?? []) {
          if (mine.has(effect)) continue;
          mine.add(effect);
          changed = true;
        }
      }
    }
  }

  for (const fn of fns) {
    const mine = effects.get(fn.name) ?? new Set<Effect>();
    const annotations = fn.annotations.filter((a) => KNOWN.has(a));

    if (annotations.includes('pure')) {
      const impure = [...mine].filter((e) => e !== 'pure');
      if (impure.length > 0) {
        report(
          'DS0260',
          `\`${fn.name}\` is annotated \`@pure\` but has the effect${impure.length === 1 ? '' : 's'} ` +
            `${impure.map((e) => `\`${e}\``).join(', ')}`,
          fn.span,
        );
      }
    }

    if (annotations.includes('deterministic')) {
      const offending = [...mine].filter((e) => !DETERMINISTIC_EFFECTS.has(e));
      if (offending.length > 0) {
        /*
         * The message names the *capability*, not only the effect.
         *
         * "has the effect audio.write" sends a reader looking for which call did it. Naming
         * `drift/audio.play` is the answer they were going to go and find, and it is information
         * this pass already has.
         */
        const reached = (capabilityOf.get(fn.name) ?? [])
          .filter((c) => !DETERMINISTIC_EFFECTS.has(c.effect))
          .map((c) => `\`${c.label}\` (${c.effect})`);
        const via = reached.length > 0 ? ` It reaches ${reached.join(', ')}.` : '';
        report(
          'DS0261',
          `\`${fn.name}\` is annotated \`@deterministic\` but has ` +
            `${offending.map((e) => `\`${e}\``).join(', ')}, which is outside the simulation ` +
            `boundary.${via}`,
          fn.span,
        );
      }
    }
  }

  const frozen = new Map<string, ReadonlySet<Effect>>();
  for (const [name, set] of effects) frozen.set(name, set);
  return { effects: frozen, diagnostics };
}

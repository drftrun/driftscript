/**
 * Where generated code allocates, and what `@hot` refuses.
 *
 * **`AGENTS.md`'s performance section, expressed as something the compiler checks.** Those rules
 * are absolute for anything called per frame or per simulation tick, and today they are enforced by
 * review, by a profiler, and by remembering. Generated code is code, and a JavaScript backend does
 * not excuse an object made sixty times a second.
 *
 * ---
 *
 * ## This reads the IR, not the source
 *
 * An allocation is a property of what the backend *emits*, not of what an author wrote — a `match`
 * looks free in source and emits a function call on an arrow, and a record literal looks like a
 * value and is an object. Running after lowering is what lets each report name the thing that
 * actually allocates.
 *
 * The cost is that these diagnostics arrive later than the type errors and are appended to them
 * rather than woven in. **What would make it wrong** is a second backend whose allocation profile
 * differs from JavaScript's, at which point this stops being a property of the IR and has to move
 * behind the backend that knows — which is the day this paragraph is deleted rather than qualified.
 *
 * ## What is not here, and why
 *
 * A **typed-array view** is named explicitly by `AGENTS.md` as an allocation, and a reader who
 * thinks a view is free is the reason it is named. It cannot appear here: the language has no array
 * type, so no expression can produce one. It arrives through a **capability**, and a capability is
 * the only thing that knows — so `allocates` is a property a binding declares, and a `@hot`
 * function calling one is reported. The check exists; what it reads is the registry rather than the
 * IR, because the host is the only party that can answer.
 */
import type { Span } from '../ast.ts';
import type { IrExpr, IrFn, IrModule, IrStmt } from '../ir/ir.ts';
import { bodiesOf, exprsOf, visitExprs, visitExprsIn } from '../ir/walk.ts';

export interface Allocation {
  readonly span: Span;
  /** What allocates, in the words a reader can act on. */
  readonly what: string;
}

/**
 * Whether this one expression allocates, and the words a report uses for it.
 *
 * **Exhaustive on purpose, and `never` is the whole point.** This is a *claim about a kind* — the
 * backend either makes an object for this node or it does not — and there is no honest default for
 * a claim. A permissive one is how a list literal, which emits a JavaScript Array, was invisible
 * here while `@hot` was being used as a machine-checked performance contract. Traversal is
 * `ir/walk.ts`'s job; deciding is this function's, and a new node must stop the build until
 * somebody decides.
 */
function allocationOf(expr: IrExpr): Allocation | null {
  switch (expr.kind) {
    case 'record':
      return { span: expr.span, what: `a \`${expr.name}\` — a record literal is an object` };
    case 'listLiteral':
      /* `[a, b]` emits `[a, b]`, which is an Array. It reads like a value in source and is the
         plainest allocation the language has — which is exactly why it was missed. */
      return {
        span: expr.span,
        what: `a list literal of ${expr.items.length} — \`[…]\` is an array, made here`,
      };
    case 'wrap':
      /* `Ok(v)`, `Err(e)` and `some(v)` are all `{ tag, value }`. `none` is a shared constant and
         is the one member of this node that costs nothing. */
      if (expr.tag === 'none') return null;
      return { span: expr.span, what: `\`${expr.tag}\` wraps its value in an object` };
    case 'optionalField':
      /* Emitted as an arrow applied to the target: a closure and, on the `some` path, an option. */
      return {
        span: expr.span,
        what: `\`?.${expr.name}\` builds an option, through a function made at the call`,
      };
    case 'match':
      return { span: expr.span, what: 'a `match` is emitted as a function made at the call' };
    case 'try':
      return {
        span: expr.span,
        what: '`?` throws a carrier object to return early, and builds one to do it',
      };
    case 'binary':
      /*
       * **String building is not here, and cannot be.** §21 lists "arbitrary string formatting"
       * among what `@hot` rejects, and `+` in this language requires numeric operands — the type
       * checker refuses `a + b` on two strings as `DS0259` long before this runs. A branch for it
       * would be one that can never be taken. The day the language grows concatenation is the day
       * it belongs here.
       */
      return null;
    case 'const':
    case 'local':
    case 'componentField':
    case 'field':
    case 'unary':
    case 'index':
      /* An index emits `$at(xs, i)` — a call and a bounds test, and no object. */
      return null;
    case 'call':
      /* A call to a capability that allocates is reported by `hotDiagnostics`, which is the only
         party holding the registry that knows. A call to an ordinary function inherits the
         callee's allocations, reported at the call site by the same function. Neither is a
         property of this node on its own. */
      return null;
    default:
      return unreachable(expr);
  }
}

/** The same claim for a statement: the two forms that build something without an expression. */
function allocationOfStmt(stmt: IrStmt): Allocation | null {
  switch (stmt.kind) {
    case 'emit':
      return { span: stmt.span, what: `\`emit ${stmt.event}\` builds its payload` };
    case 'spawn':
      return { span: stmt.span, what: `\`spawn ${stmt.task}\` allocates the task frame` };
    case 'awaitTask':
      return { span: stmt.span, what: `awaiting \`${stmt.task}\` allocates its frame` };
    case 'let':
    case 'assign':
    case 'return':
    case 'loopJump':
    case 'if':
    case 'ifLet':
    case 'while':
    case 'forList':
    case 'forQuery':
    case 'await':
    case 'scope':
    case 'become':
    case 'expr':
      /*
       * A loop allocates nothing by *being* one. `forList` reads a list it was handed and
       * `forQuery` hoists views the host owns — what either costs is whatever its body does, and
       * the walk reaches that through `ir/walk.ts` rather than through a case here.
       */
      return null;
    default:
      return unreachable(stmt);
  }
}

function unreachable(node: never): never {
  throw new Error(
    `\`check/hot.ts\` has not decided whether \`${(node as { kind: string }).kind}\` allocates. ` +
      'Until it does, a `@hot` function containing one is accepted without being checked.',
  );
}

/**
 * Every allocation a function's own body performs, in source order.
 *
 * Its own only — what a function it calls does is the caller's problem to inherit, and `hotErrors`
 * is what walks the call graph. Keeping this local is what makes it answerable for one function
 * without a whole module.
 */
export function allocationsIn(fn: IrFn): Allocation[] {
  const found: Allocation[] = [];
  const collect = (stmts: readonly IrStmt[]): void => {
    for (const stmt of stmts) {
      const own = allocationOfStmt(stmt);
      if (own !== null) found.push(own);
      for (const expr of exprsOf(stmt)) {
        visitExprs(expr, (node) => {
          const allocation = allocationOf(node);
          if (allocation !== null) found.push(allocation);
        });
      }
      for (const body of bodiesOf(stmt)) collect(body);
    }
  };
  collect(fn.body);
  return found;
}

/** Whether a function is annotated `@hot`. */
export function isHot(fn: IrFn): boolean {
  return fn.annotations.includes('hot');
}

/**
 * Every call in a function's body that satisfies `wanted`, with the span to report it at.
 *
 * **One walk for both questions, because they were two copies of one bug.** `callsIn` found
 * ordinary functions so a hot root could inherit their allocations, and `capabilityCalls` found
 * dotted callees so a forbidden effect could be refused — and each carried its own recursive
 * `switch`, each skipping the same nested positions. A call in an `if` condition was invisible to
 * both. Traversal now comes from `ir/walk.ts`, so a position added to the IR is reached by this
 * without anything here changing.
 */
function callsMatching(
  fn: IrFn,
  wanted: (callee: string) => boolean,
): { callee: string; span: Span }[] {
  const calls: { callee: string; span: Span }[] = [];
  visitExprsIn(fn.body, (expr) => {
    if (expr.kind === 'call' && wanted(expr.callee)) {
      calls.push({ callee: expr.callee, span: expr.span });
    }
  });
  return calls;
}

/** Which functions a function calls, by name, within this module. */
export function callsIn(fn: IrFn, known: ReadonlySet<string>): string[] {
  return callsMatching(fn, (callee) => known.has(callee)).map((call) => call.callee);
}

/** Every function in a module, by name. */
export function functionsOf(ir: IrModule): Map<string, IrFn> {
  return new Map(ir.fns.map((fn) => [fn.name, fn]));
}

/**
 * The effects a hot path may not reach, and why each is here rather than merely discouraged.
 *
 * §21 lists what `@hot` rejects: heap allocation, AI calls, persistence writes, arbitrary string
 * formatting, dynamic module loading, resource creation and expensive reflection. Of those, the
 * ones a capability can *declare* are these — and `audio.write` is named by §11 explicitly, for the
 * same reason the engine's own rules forbid allocation in a frame.
 *
 * **Reads are deliberately absent.** `scene.read` and `clock.read` are what a per-frame function is
 * usually for, and a rule that refused them would refuse the hot path itself.
 */
const OUTSIDE_A_HOT_PATH: ReadonlySet<string> = new Set([
  'audio.write',
  'ai',
  'host',
  'persistence.read',
  'persistence.write',
]);

/** What the checker needs to know about a capability, without importing a registry. */
export interface HotCapability {
  readonly effects: readonly string[];
  /**
   * Whether calling it allocates on the host's side.
   *
   * The only way a typed-array view — which `AGENTS.md` names as an allocation — can be seen from
   * here, because the language has no array type and the host is the only party that knows.
   */
  readonly allocates?: boolean;
}

export interface HotDiagnostic {
  readonly code: 'DS0400' | 'DS0401';
  readonly message: string;
  readonly span: Span;
}

/**
 * Everything a module's `@hot` functions do that a hot path may not.
 *
 * A `@hot` function that calls an ordinary one **inherits its allocations**, reported at the call
 * site rather than inside the callee: the callee is not annotated and is entitled to allocate, and
 * the mistake is calling it from here. Cycles terminate because each function is visited once per
 * root.
 */
export function hotDiagnostics(
  ir: IrModule,
  capabilities?: ReadonlyMap<string, HotCapability>,
): HotDiagnostic[] {
  const found: HotDiagnostic[] = [];
  const byName = functionsOf(ir);
  const names = new Set(byName.keys());

  for (const fn of ir.fns) {
    if (!isHot(fn)) continue;

    for (const allocation of allocationsIn(fn)) {
      found.push({
        code: 'DS0400',
        message: `\`${fn.name}\` is \`@hot\` and allocates: ${allocation.what}`,
        span: allocation.span,
      });
    }

    for (const call of capabilityCalls(fn)) {
      const capability = capabilities?.get(call.callee);
      if (capability === undefined) continue;
      const offending = capability.effects.filter((effect) => OUTSIDE_A_HOT_PATH.has(effect));
      if (offending.length > 0) {
        found.push({
          code: 'DS0401',
          message:
            `\`${fn.name}\` is \`@hot\` and calls \`${call.callee}\`, which has ` +
            `${offending.map((e) => `\`${e}\``).join(', ')}. That is work a frame cannot afford ` +
            'to wait for, and the engine forbids it in a hot path for the same reason it forbids ' +
            'allocation there.',
          span: call.span,
        });
      }
      if (capability.allocates === true) {
        found.push({
          code: 'DS0400',
          message: `\`${fn.name}\` is \`@hot\` and calls \`${call.callee}\`, which allocates`,
          span: call.span,
        });
      }
    }

    /* What it reaches through ordinary functions, reported where the call is written. */
    const seen = new Set<string>([fn.name]);
    const queue = callsIn(fn, names).map((name) => ({ name, span: fn.span }));
    while (queue.length > 0) {
      const next = queue.pop();
      if (next === undefined || seen.has(next.name)) continue;
      seen.add(next.name);
      const callee = byName.get(next.name);
      if (callee === undefined || isHot(callee)) continue;

      for (const allocation of allocationsIn(callee)) {
        found.push({
          code: 'DS0400',
          message:
            `\`${fn.name}\` is \`@hot\` and reaches \`${next.name}\`, which allocates: ` +
            `${allocation.what}`,
          span: allocation.span,
        });
      }
      for (const name of callsIn(callee, names)) queue.push({ name, span: callee.span });
    }
  }

  return found;
}

/** Every dotted call in a function's body — a capability, or an enum constructor. */
function capabilityCalls(fn: IrFn): { callee: string; span: Span }[] {
  return callsMatching(fn, (callee) => callee.includes('.'));
}

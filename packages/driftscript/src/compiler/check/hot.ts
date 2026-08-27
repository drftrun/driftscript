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

export interface Allocation {
  readonly span: Span;
  /** What allocates, in the words a reader can act on. */
  readonly what: string;
}

function walkExpr(expr: IrExpr, found: Allocation[]): void {
  switch (expr.kind) {
    case 'record':
      found.push({ span: expr.span, what: `a \`${expr.name}\` — a record literal is an object` });
      for (const field of expr.fields) walkExpr(field.value, found);
      return;
    case 'wrap':
      /* `Ok(v)`, `Err(e)` and `some(v)` are all `{ tag, value }`. `none` is a shared constant and
         is the one member of this node that costs nothing. */
      if (expr.tag !== 'none') {
        found.push({ span: expr.span, what: `\`${expr.tag}\` wraps its value in an object` });
      }
      if (expr.value !== null) walkExpr(expr.value, found);
      return;
    case 'optionalField':
      /* Emitted as an arrow applied to the target: a closure and, on the `some` path, an option. */
      found.push({
        span: expr.span,
        what: `\`?.${expr.name}\` builds an option, through a function made at the call`,
      });
      walkExpr(expr.target, found);
      return;
    case 'match':
      found.push({ span: expr.span, what: 'a `match` is emitted as a function made at the call' });
      walkExpr(expr.subject, found);
      for (const arm of expr.arms) walkExpr(arm.body, found);
      return;
    case 'try':
      found.push({
        span: expr.span,
        what: '`?` throws a carrier object to return early, and builds one to do it',
      });
      walkExpr(expr.inner, found);
      return;
    case 'binary':
      /*
       * **String building is not here, and cannot be.** §21 lists "arbitrary string formatting"
       * among what `@hot` rejects, and `+` in this language requires numeric operands — the type
       * checker refuses `a + b` on two strings as `DS0259` long before this runs. A branch for it
       * would be one that can never be taken. The day the language grows concatenation is the day
       * it belongs here.
       */
      walkExpr(expr.left, found);
      walkExpr(expr.right, found);
      return;
    case 'unary':
      walkExpr(expr.operand, found);
      return;
    case 'call':
      for (const arg of expr.args) walkExpr(arg, found);
      return;
    case 'field':
      walkExpr(expr.target, found);
      return;
    default:
      return;
  }
}

function walkStmts(stmts: readonly IrStmt[], found: Allocation[]): void {
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case 'let':
        walkExpr(stmt.value, found);
        break;
      case 'assign':
        walkExpr(stmt.target, found);
        walkExpr(stmt.value, found);
        break;
      case 'return':
        if (stmt.value !== null) walkExpr(stmt.value, found);
        break;
      case 'expr':
        walkExpr(stmt.expr, found);
        break;
      case 'if':
        walkExpr(stmt.condition, found);
        walkStmts(stmt.then, found);
        if (stmt.otherwise !== null) walkStmts(stmt.otherwise, found);
        break;
      case 'ifLet':
        walkExpr(stmt.subject, found);
        walkStmts(stmt.then, found);
        if (stmt.otherwise !== null) walkStmts(stmt.otherwise, found);
        break;
      case 'while':
        walkExpr(stmt.condition, found);
        walkStmts(stmt.body, found);
        break;
      case 'scope':
        walkStmts(stmt.body, found);
        break;
      case 'emit':
        found.push({ span: stmt.span, what: `\`emit ${stmt.event}\` builds its payload` });
        for (const field of stmt.fields) walkExpr(field.value, found);
        break;
      case 'spawn':
        found.push({ span: stmt.span, what: `\`spawn ${stmt.task}\` allocates the task frame` });
        for (const arg of stmt.args) walkExpr(arg, found);
        break;
      case 'awaitTask':
        found.push({ span: stmt.span, what: `awaiting \`${stmt.task}\` allocates its frame` });
        for (const arg of stmt.args) walkExpr(arg, found);
        break;
      default:
        break;
    }
  }
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
  walkStmts(fn.body, found);
  return found;
}

/** Whether a function is annotated `@hot`. */
export function isHot(fn: IrFn): boolean {
  return fn.annotations.includes('hot');
}

/** Which functions a function calls, by name, within this module. */
export function callsIn(fn: IrFn, known: ReadonlySet<string>): string[] {
  const names: string[] = [];
  const visitExpr = (expr: IrExpr): void => {
    if (expr.kind === 'call') {
      if (known.has(expr.callee)) names.push(expr.callee);
      for (const arg of expr.args) visitExpr(arg);
      return;
    }
    switch (expr.kind) {
      case 'binary':
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case 'unary':
        visitExpr(expr.operand);
        return;
      case 'field':
      case 'optionalField':
        visitExpr(expr.target);
        return;
      case 'record':
        for (const field of expr.fields) visitExpr(field.value);
        return;
      case 'wrap':
        if (expr.value !== null) visitExpr(expr.value);
        return;
      case 'try':
        visitExpr(expr.inner);
        return;
      case 'match':
        visitExpr(expr.subject);
        for (const arm of expr.arms) visitExpr(arm.body);
        return;
      default:
        return;
    }
  };

  const visit = (stmts: readonly IrStmt[]): void => {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case 'let':
          visitExpr(stmt.value);
          break;
        case 'assign':
          visitExpr(stmt.target);
          visitExpr(stmt.value);
          break;
        case 'return':
          if (stmt.value !== null) visitExpr(stmt.value);
          break;
        case 'expr':
          visitExpr(stmt.expr);
          break;
        case 'if':
        case 'ifLet':
          visit(stmt.then);
          if (stmt.otherwise !== null) visit(stmt.otherwise);
          break;
        case 'while':
        case 'scope':
          visit(stmt.body);
          break;
        default:
          break;
      }
    }
  };
  visit(fn.body);
  return names;
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
  const calls: { callee: string; span: Span }[] = [];
  const visitExpr = (expr: IrExpr): void => {
    if (expr.kind === 'call') {
      if (expr.callee.includes('.')) calls.push({ callee: expr.callee, span: expr.span });
      for (const arg of expr.args) visitExpr(arg);
      return;
    }
    switch (expr.kind) {
      case 'binary':
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case 'unary':
        visitExpr(expr.operand);
        return;
      case 'field':
      case 'optionalField':
        visitExpr(expr.target);
        return;
      case 'record':
        for (const field of expr.fields) visitExpr(field.value);
        return;
      case 'wrap':
        if (expr.value !== null) visitExpr(expr.value);
        return;
      case 'try':
        visitExpr(expr.inner);
        return;
      case 'match':
        visitExpr(expr.subject);
        for (const arm of expr.arms) visitExpr(arm.body);
        return;
      default:
        return;
    }
  };

  const visit = (stmts: readonly IrStmt[]): void => {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case 'let':
          visitExpr(stmt.value);
          break;
        case 'assign':
          visitExpr(stmt.target);
          visitExpr(stmt.value);
          break;
        case 'return':
          if (stmt.value !== null) visitExpr(stmt.value);
          break;
        case 'expr':
          visitExpr(stmt.expr);
          break;
        case 'if':
        case 'ifLet':
          visit(stmt.then);
          if (stmt.otherwise !== null) visit(stmt.otherwise);
          break;
        case 'while':
        case 'scope':
          visit(stmt.body);
          break;
        default:
          break;
      }
    }
  };
  visit(fn.body);
  return calls;
}

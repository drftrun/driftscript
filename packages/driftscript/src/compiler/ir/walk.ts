/**
 * One description of what an IR node contains, so an analysis cannot forget a nested position.
 *
 * **This file exists because nine hand-written walkers disagreed with the IR and with each other.**
 * Every semantic pass over the IR used to carry its own recursive `switch`, and every one of them
 * ended in a permissive `default` — so a node kind a walker did not name was skipped in silence.
 * That is not a maintenance smell, it is how 1.9.0 shipped five miscompiles: a task local read
 * inside `[a, b]` or `xs[i]` emitted a bare identifier, an `emit` inside a `for` loop emitted a
 * call on a `$rt` the module never declared, and a `?` inside one left its function unwrapped. Each
 * was one missing `case` in a different file, and each compiled clean.
 *
 * The fix is not nine exhaustive switches, which is nine places to remember. It is one:
 *
 * - a pass that only needs to **reach** every expression asks this file for the children and never
 *   names a kind at all, so a node added tomorrow is walked correctly today;
 * - a pass that makes a **claim about a kind** — `hot.ts` deciding what allocates, `task.ts`
 *   rebuilding a node — keeps its own switch and ends it on `never`, because there is no safe
 *   default for a claim and the compiler should refuse to build until somebody decides.
 *
 * **What would make this wrong** is an IR node whose children are context-dependent — one whose
 * sub-expressions mean different things depending on where the walker came from. Nothing here is
 * like that today, and a node that was would have to be walked by hand with a comment saying so.
 */
import type { IrExpr, IrStmt } from './ir.ts';

/**
 * Every expression directly inside this one, in evaluation order.
 *
 * Order matters to exactly one caller — `hot.ts` reports allocations in source order — and costs
 * nothing to the rest, so it is a promise this file keeps rather than an accident of the switch.
 */
export function childExprs(expr: IrExpr): readonly IrExpr[] {
  switch (expr.kind) {
    case 'const':
    case 'local':
    case 'componentField':
      return [];
    case 'field':
    case 'optionalField':
      return [expr.target];
    case 'binary':
      return [expr.left, expr.right];
    case 'unary':
      return [expr.operand];
    case 'call':
      return expr.args;
    case 'listLiteral':
      return expr.items;
    case 'index':
      return [expr.target, expr.at];
    case 'record':
      return expr.fields.map((field) => field.value);
    case 'wrap':
      return expr.value === null ? [] : [expr.value];
    case 'try':
      return [expr.inner];
    case 'match':
      return [expr.subject, ...expr.arms.map((arm) => arm.body)];
    default:
      return unreachableExpr(expr);
  }
}

/**
 * Every expression a statement holds directly, in evaluation order.
 *
 * A loop's subject and an `if`'s condition are here, and they are the two positions the old walkers
 * missed most often — an allocation in a condition and a capability call in a `for` subject were
 * both invisible to `@hot`.
 */
export function exprsOf(stmt: IrStmt): readonly IrExpr[] {
  switch (stmt.kind) {
    case 'let':
      return [stmt.value];
    case 'assign':
      return [stmt.target, stmt.value];
    case 'return':
      return stmt.value === null ? [] : [stmt.value];
    case 'loopJump':
    case 'become':
    case 'scope':
      return [];
    case 'if':
    case 'while':
      return [stmt.condition];
    case 'ifLet':
      return [stmt.subject];
    case 'forList':
      return [stmt.subject];
    case 'forQuery':
      /* A query names components rather than evaluating anything: the world is an identifier the
         lowering resolved, and the terms are strings. Only the body carries expressions. */
      return [];
    case 'await':
      return [stmt.duration];
    case 'spawn':
    case 'awaitTask':
      return stmt.args;
    case 'emit':
      return stmt.fields.map((field) => field.value);
    case 'expr':
      return [stmt.expr];
    default:
      return unreachableStmt(stmt);
  }
}

/** Every statement list a statement holds, outermost first. */
export function bodiesOf(stmt: IrStmt): readonly (readonly IrStmt[])[] {
  switch (stmt.kind) {
    case 'let':
    case 'assign':
    case 'return':
    case 'loopJump':
    case 'become':
    case 'await':
    case 'spawn':
    case 'awaitTask':
    case 'emit':
    case 'expr':
      return [];
    case 'if':
    case 'ifLet':
      return stmt.otherwise === null ? [stmt.then] : [stmt.then, stmt.otherwise];
    case 'while':
    case 'forList':
    case 'forQuery':
    case 'scope':
      return [stmt.body];
    default:
      return unreachableStmt(stmt);
  }
}

/**
 * Call `visit` on this expression and every expression beneath it, parents first.
 *
 * The traversal is the whole of what most analyses needed from their own walkers, and taking it
 * from here is what stops the next IR node from being invisible to them.
 */
export function visitExprs(expr: IrExpr, visit: (expr: IrExpr) => void): void {
  visit(expr);
  for (const child of childExprs(expr)) visitExprs(child, visit);
}

/** Call `visit` on every expression in these statements, at any depth, in source order. */
export function visitExprsIn(stmts: readonly IrStmt[], visit: (expr: IrExpr) => void): void {
  for (const stmt of stmts) {
    for (const expr of exprsOf(stmt)) visitExprs(expr, visit);
    for (const body of bodiesOf(stmt)) visitExprsIn(body, visit);
  }
}

/** Call `visit` on every statement in these, at any depth, in source order. Parents first. */
export function visitStmts(stmts: readonly IrStmt[], visit: (stmt: IrStmt) => void): void {
  for (const stmt of stmts) {
    visit(stmt);
    for (const body of bodiesOf(stmt)) visitStmts(body, visit);
  }
}

/**
 * Whether any statement at any depth satisfies `predicate`.
 *
 * It **does** descend into loops, which is the difference between this and the loop-jump search in
 * `emit/task.ts` — that one stops at a nested loop on purpose, because a jump inside one belongs to
 * it. Anything that stops early is written where the reason lives rather than here.
 */
export function anyStmt(stmts: readonly IrStmt[], predicate: (stmt: IrStmt) => boolean): boolean {
  for (const stmt of stmts) {
    if (predicate(stmt)) return true;
    for (const body of bodiesOf(stmt)) {
      if (anyStmt(body, predicate)) return true;
    }
  }
  return false;
}

/** Whether any expression anywhere in these statements satisfies `predicate`. */
export function anyExprIn(
  stmts: readonly IrStmt[],
  predicate: (expr: IrExpr) => boolean,
): boolean {
  let found = false;
  visitExprsIn(stmts, (expr) => {
    if (predicate(expr)) found = true;
  });
  return found;
}

/*
 * The two refusals that make this file the only place an IR addition has to be handled.
 *
 * A `never` parameter is a compile error the moment `IrExpr` or `IrStmt` grows a member this file
 * does not name, and the throw is what happens if one reaches here at runtime anyway — through a
 * cast, or a node built by a test. Reporting the kind is what turns that into a sentence rather
 * than an `undefined` three frames later.
 */
function unreachableExpr(expr: never): never {
  throw new Error(
    `\`childExprs\` does not know \`${(expr as { kind: string }).kind}\`, so every expression ` +
      'inside one is invisible to every analysis. Add a case in `compiler/ir/walk.ts`.',
  );
}

function unreachableStmt(stmt: never): never {
  throw new Error(
    `\`compiler/ir/walk.ts\` does not know \`${(stmt as { kind: string }).kind}\`, so everything ` +
      'inside one is invisible to every analysis. Add a case for it.',
  );
}

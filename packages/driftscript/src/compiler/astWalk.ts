/**
 * The same one-description rule as `ir/walk.ts`, for the syntax tree.
 *
 * Two files rather than one because the two trees are genuinely different — an AST `call` has an
 * *expression* callee where the IR's is a resolved name, and the AST has `compoundAssign` where
 * the IR has none. A shared walker would have to be written against whichever tree it understood
 * less well.
 *
 * The passes that read the AST are the ones answering "what does this code touch": effect
 * inference and component-access inference. Both are **negative** guarantees — `@deterministic`
 * means nothing was reached that is not deterministic — so a node either walker skips turns a
 * refusal into an acceptance, silently. `check/effects.ts` already carries a comment about the day
 * the query loop landed and `@deterministic` started passing for a function playing audio inside a
 * `for`; that walker was fixed and its expression half was not, so a call inside `[f()]` or
 * `xs[f()]` was still invisible.
 */
import type { Expr, Stmt } from './ast.ts';

/** Every expression directly inside this one, in evaluation order. */
export function childExprs(expr: Expr): readonly Expr[] {
  switch (expr.kind) {
    case 'number':
    case 'string':
    case 'bool':
    case 'ident':
      return [];
    case 'member':
    case 'optionalMember':
      return [expr.target];
    case 'binary':
      return [expr.left, expr.right];
    case 'unary':
      return [expr.operand];
    case 'call':
      /* The callee is an expression here, unlike the IR's resolved name, and a call *through* one
         — `things.at(i)(x)` shaped code — would hide everything in it from a walk that took only
         the arguments. The checker refuses that shape today; taking the callee anyway costs one
         array slot and stops this file having an opinion about what the checker allows. */
      return [expr.callee, ...expr.args];
    case 'record':
      return expr.fields.map((field) => field.value);
    case 'listLiteral':
      return expr.items;
    case 'index':
      return [expr.target, expr.at];
    case 'try':
      return [expr.inner];
    case 'match':
      return [expr.subject, ...expr.arms.map((arm) => arm.body)];
    default:
      return unreachableExpr(expr);
  }
}

/** Every expression a statement holds directly, in evaluation order. */
export function exprsOf(stmt: Stmt): readonly Expr[] {
  switch (stmt.kind) {
    case 'let':
      return [stmt.value];
    case 'assign':
    case 'compoundAssign':
      return [stmt.target, stmt.value];
    case 'return':
      return stmt.value === undefined ? [] : [stmt.value];
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
      /* A query spec names components and nothing else — there is no expression in one to walk. */
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
export function bodiesOf(stmt: Stmt): readonly (readonly Stmt[])[] {
  switch (stmt.kind) {
    case 'let':
    case 'assign':
    case 'compoundAssign':
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
      return stmt.otherwise === undefined ? [stmt.then] : [stmt.then, stmt.otherwise];
    case 'while':
    case 'forList':
    case 'forQuery':
    case 'scope':
      return [stmt.body];
    default:
      return unreachableStmt(stmt);
  }
}

/** Call `visit` on this expression and every expression beneath it, parents first. */
export function visitExprs(expr: Expr, visit: (expr: Expr) => void): void {
  visit(expr);
  for (const child of childExprs(expr)) visitExprs(child, visit);
}

/** Call `visit` on every expression in these statements, at any depth, in source order. */
export function visitExprsIn(stmts: readonly Stmt[], visit: (expr: Expr) => void): void {
  for (const stmt of stmts) {
    for (const expr of exprsOf(stmt)) visitExprs(expr, visit);
    for (const body of bodiesOf(stmt)) visitExprsIn(body, visit);
  }
}

/** Call `visit` on every statement in these, at any depth, in source order. Parents first. */
export function visitStmts(stmts: readonly Stmt[], visit: (stmt: Stmt) => void): void {
  for (const stmt of stmts) {
    visit(stmt);
    for (const body of bodiesOf(stmt)) visitStmts(body, visit);
  }
}

function unreachableExpr(expr: never): never {
  throw new Error(
    `\`childExprs\` does not know \`${(expr as { kind: string }).kind}\`, so every expression ` +
      'inside one is invisible to effect and component-access inference. Add a case in ' +
      '`compiler/astWalk.ts`.',
  );
}

function unreachableStmt(stmt: never): never {
  throw new Error(
    `\`compiler/astWalk.ts\` does not know \`${(stmt as { kind: string }).kind}\`, so everything ` +
      'inside one is invisible to effect and component-access inference. Add a case for it.',
  );
}

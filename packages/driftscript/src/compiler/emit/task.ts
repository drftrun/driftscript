/**
 * A task, turned into a state machine.
 *
 * **A resume is a switch on an integer, not a closure.** That is the whole reason this file exists
 * instead of the task being an `async function`: a promise chain allocates a closure and a promise
 * per await, per task, per resume, and a scheduler running per simulation step turns that into the
 * per-frame allocation `AGENTS.md` forbids — arrived at one `await` at a time.
 *
 * ---
 *
 * ## The shape
 *
 * The body is cut into **blocks** at every point control can arrive from somewhere other than the
 * statement above. A block runs its statements and then does one of four things: suspend on a
 * clock, jump, branch, or finish. Emitted, that is a `for (;;)` around a `switch`, where a jump is
 * `continue` and a suspend is `return`.
 *
 * **Only control flow that contains an `await` is cut.** An `if` or a `while` with no suspend
 * inside it is emitted as itself, by the ordinary statement emitter, because splitting it would buy
 * nothing and cost every reader of the output. The cost is a generated body that mixes two shapes;
 * what would make it wrong is a reader expecting the block list to describe the whole control flow,
 * which is why this paragraph is here rather than in a commit message.
 *
 * ## Locals live on the frame
 *
 * Everything a task declares — its parameters and its `let`s — becomes a field on the frame the
 * scheduler owns, because anything else dies at the `return` that suspends. The rewrite is done on
 * the IR before emission, so the ordinary expression emitter needs to know nothing about tasks.
 *
 * The cost is that two `let`s of one name would be one slot, so that is refused rather than
 * renamed. **What would make that wrong** is a corpus file that reads better with a shadowed
 * binding, at which point the fix is alpha-renaming here and not a change to the language.
 */
import type { Span } from '../ast.ts';
import type { IrExpr, IrOwner, IrStmt, IrTask } from '../ir/ir.ts';
import { anyStmt, visitStmts } from '../ir/walk.ts';

/**
 * A statement inside a block, which is the language's own plus two the cut introduces.
 *
 * A `scope` that spans a suspend has no single statement to be: its open and its close land in
 * different blocks. Those two exist here rather than in `IrStmt` because they are an artefact of
 * cutting a body into blocks — a second backend that did not cut would never produce one, and
 * putting them in the shared IR would make every reader of it handle a case only this file emits.
 */
export type TaskStmt =
  | IrStmt
  | {
      readonly kind: 'scopeOpen';
      readonly name: string;
      readonly parent: IrOwner;
      readonly span: Span;
    }
  | { readonly kind: 'scopeClose'; readonly name: string; readonly span: Span };

/** Where control goes when a block's statements are done. */
export type Terminator =
  | { readonly kind: 'jump'; readonly target: number }
  | {
      readonly kind: 'branch';
      readonly condition: IrExpr;
      readonly then: number;
      readonly otherwise: number;
    }
  | {
      readonly kind: 'await';
      readonly clock: 'fixed' | 'frame' | 'wall';
      readonly duration: IrExpr;
      readonly next: number;
    }
  | {
      readonly kind: 'awaitTask';
      readonly task: string;
      readonly owner: IrOwner;
      readonly args: readonly IrExpr[];
      readonly next: number;
    }
  | { readonly kind: 'done' };

export interface Block {
  readonly stmts: TaskStmt[];
  terminator: Terminator;
}

/**
 * The JavaScript expression naming what a spawn or a nested scope belongs to.
 *
 * A `scope` block is always inside a task, so its handle is always a frame field — which is why
 * there is no fourth case for a scope in an ordinary function.
 */
export function ownerText(owner: IrOwner): string {
  switch (owner.kind) {
    case 'module':
      return '$rt.scope';
    case 'task':
      return '$f.owner';
    case 'scope':
      return `$f.${frameField(owner.name)}`;
  }
}

/** The frame field a task's binding lives in. Prefixed so it cannot collide with `step` or `clock`. */
export function frameField(name: string): string {
  return `$${name}`;
}

/**
 * Whether any statement in this list, at any depth, suspends.
 *
 * **The descent comes from `ir/walk.ts`.** It used to name four statement kinds and fall through a
 * permissive `default`, which meant an `await` inside a `for … in` was invisible to the cutter —
 * the body was never cut, the suspend reached the ordinary statement emitter, and the compiler
 * threw a bare internal `Error` at a program that is perfectly reasonable to write.
 */
export function containsAwait(stmts: readonly IrStmt[]): boolean {
  return anyStmt(stmts, (stmt) => stmt.kind === 'await' || stmt.kind === 'awaitTask');
}

/**
 * Whether this `for … in` has to become blocks rather than a JavaScript loop.
 *
 * **One predicate, read by both the cutter and `frameNames`.** They have to agree exactly: a loop
 * that is cut keeps its binding on the frame, and one that is not keeps it in a `const` the
 * JavaScript loop declares. Two copies of the rule would disagree the first time either moved, and
 * the failure is a binding written to one place and read from the other — which is the shape of
 * three of the miscompiles this release fixes.
 */
export function cutsForList(stmt: Extract<IrStmt, { kind: 'forList' }>): boolean {
  return containsAwait(stmt.body);
}

/** The frame fields a cut `for … in` keeps its position in: the list it walks, and the index. */
export function listFields(depth: number): { list: string; index: string } {
  return { list: `$l${depth}`, index: `$n${depth}` };
}

/**
 * Every name a task binds: its parameters, then every `let` at any depth.
 *
 * The walk used to stop at a `for` loop, so a `let` written inside one was rewritten into a frame
 * *write* while every read of it stayed a bare identifier — a `ReferenceError` on the first
 * iteration, from code that compiled without a diagnostic.
 */
export function frameNames(task: IrTask): string[] {
  const names = task.params.map((p) => p.name);
  visitStmts(task.body, (stmt) => {
    if (stmt.kind === 'let') names.push(stmt.name);
    /* A scope's handle lives on the frame like any other binding: the block it belongs to can span
       a suspend, and a scope that died at one would leave its tasks unowned. */
    if (stmt.kind === 'scope') names.push(stmt.name);
    if (stmt.kind === 'forList' && cutsForList(stmt)) {
      /* A cut loop's binding survives the suspension in its body, and so must the two temporaries
         that say where the walk had got to. They are named `$l`/`$n` so `frameField` prefixes them
         into `$$l0`/`$$n0`, which no source identifier can collide with — a `$` cannot start one. */
      const { list, index } = listFields(stmt.depth);
      names.push(stmt.binding, list, index);
    }
  });
  return names;
}

/**
 * Rewrite every reference to a task binding into a read of the frame field that holds it.
 *
 * **Exhaustive, and it cannot borrow `ir/walk.ts` for it.** This rebuilds each node rather than
 * visiting it, so there is no generic child iteration that would help — a walker can hand back
 * children, but only this function knows how to put a node back together. A `default` here is a
 * node returned unchanged, which for an expression holding a task local means an identifier that
 * no scope declares: `[a, a]` and `xs[i]` both shipped that way in 1.9.0. The `never` below is what
 * makes the next such node a compile error instead.
 */
function rewriteExpr(expr: IrExpr, bound: ReadonlySet<string>): IrExpr {
  switch (expr.kind) {
    case 'local':
      if (!bound.has(expr.name)) return expr;
      return {
        kind: 'field',
        target: { kind: 'local', name: '$f', type: expr.type, span: expr.span },
        name: frameField(expr.name),
        type: expr.type,
        span: expr.span,
      };
    case 'const':
    case 'componentField':
      /* A literal and a column read, neither of which can name a task binding: a `componentField`
         resolves to a view and an index the loop owns. */
      return expr;
    case 'field':
    case 'optionalField':
      return { ...expr, target: rewriteExpr(expr.target, bound) };
    case 'binary':
      return {
        ...expr,
        left: rewriteExpr(expr.left, bound),
        right: rewriteExpr(expr.right, bound),
      };
    case 'unary':
      return { ...expr, operand: rewriteExpr(expr.operand, bound) };
    case 'call':
      return { ...expr, args: expr.args.map((a) => rewriteExpr(a, bound)) };
    case 'listLiteral':
      return { ...expr, items: expr.items.map((item) => rewriteExpr(item, bound)) };
    case 'index':
      return { ...expr, target: rewriteExpr(expr.target, bound), at: rewriteExpr(expr.at, bound) };
    case 'record':
      return {
        ...expr,
        fields: expr.fields.map((f) => ({ name: f.name, value: rewriteExpr(f.value, bound) })),
      };
    case 'wrap':
      return { ...expr, value: expr.value === null ? null : rewriteExpr(expr.value, bound) };
    case 'try':
      return { ...expr, inner: rewriteExpr(expr.inner, bound) };
    case 'match':
      return {
        ...expr,
        subject: rewriteExpr(expr.subject, bound),
        /* An arm's binding is a fresh name the arm introduces, so it is deliberately not rewritten:
           it never outlives the expression and can never cross a suspend. */
        arms: expr.arms.map((arm) => ({ ...arm, body: rewriteExpr(arm.body, bound) })),
      };
    default:
      return unrewritten(expr);
  }
}

function unrewritten(expr: never): never {
  throw new Error(
    `task lowering does not rewrite \`${(expr as { kind: string }).kind}\`, so a task local named ` +
      'inside one would emit an identifier no scope declares. Add a case above.',
  );
}

/** The same rewrite over statements, turning a `let` into an assignment to its frame field. */
export function rewriteStmts(stmts: readonly IrStmt[], bound: ReadonlySet<string>): IrStmt[] {
  return stmts.map((stmt): IrStmt => {
    switch (stmt.kind) {
      case 'let':
        return {
          kind: 'assign',
          target: {
            kind: 'field',
            target: { kind: 'local', name: '$f', type: stmt.type, span: stmt.span },
            name: frameField(stmt.name),
            type: stmt.type,
            span: stmt.span,
          },
          value: rewriteExpr(stmt.value, bound),
          span: stmt.span,
        };
      case 'assign':
        return {
          ...stmt,
          target: rewriteExpr(stmt.target, bound),
          value: rewriteExpr(stmt.value, bound),
        };
      case 'forQuery':
        /*
         * The body is rewritten and the binding is not, which is the same call the `match` arm
         * above makes and for the same reason: the binding is a fresh name this loop introduces,
         * it never outlives the loop, and it can never cross a suspend — a query loop may not
         * `await` at all, because its cursor comes from a pool and is given back when the loop
         * ends. The body still needs rewriting, because it can read a task local that lives in
         * the frame.
         */
        return { ...stmt, body: rewriteStmts(stmt.body, bound) };
      case 'return':
        return { ...stmt, value: stmt.value === null ? null : rewriteExpr(stmt.value, bound) };
      case 'if':
        return {
          ...stmt,
          condition: rewriteExpr(stmt.condition, bound),
          then: rewriteStmts(stmt.then, bound),
          otherwise: stmt.otherwise === null ? null : rewriteStmts(stmt.otherwise, bound),
        };
      case 'ifLet':
        return {
          ...stmt,
          subject: rewriteExpr(stmt.subject, bound),
          then: rewriteStmts(stmt.then, bound),
          otherwise: stmt.otherwise === null ? null : rewriteStmts(stmt.otherwise, bound),
        };
      case 'while':
        return {
          ...stmt,
          condition: rewriteExpr(stmt.condition, bound),
          body: rewriteStmts(stmt.body, bound),
        };
      case 'await':
        return { ...stmt, duration: rewriteExpr(stmt.duration, bound) };
      case 'awaitTask':
        return { ...stmt, args: stmt.args.map((a) => rewriteExpr(a, bound)) };
      case 'become':
        return stmt;
      case 'loopJump':
        /* A keyword and a cursor depth, neither of which can name a task local. */
        return stmt;
      case 'forList':
        /* The subject is an expression and may name a task local; the binding is this loop's own
           and never outlives it, which is the call `forQuery` makes one case up. */
        return { ...stmt, subject: rewriteExpr(stmt.subject, bound), body: rewriteStmts(stmt.body, bound) };
      case 'emit':
        return {
          ...stmt,
          fields: stmt.fields.map((f) => ({ name: f.name, value: rewriteExpr(f.value, bound) })),
        };
      case 'spawn':
        return { ...stmt, args: stmt.args.map((a) => rewriteExpr(a, bound)) };
      case 'scope':
        return { ...stmt, body: rewriteStmts(stmt.body, bound) };
      case 'expr':
        return { ...stmt, expr: rewriteExpr(stmt.expr, bound) };
    }
  });
}

/**
 * Whether these statements contain a `break` or `continue` that belongs to an enclosing loop.
 *
 * **It does not descend into a nested loop**, because a jump inside one is that loop's business and
 * becomes an ordinary JavaScript `break` in ordinary JavaScript. It does descend into `if`, `ifLet`
 * and `scope`, which are not loops and do not catch a jump.
 *
 * This exists for one hazard, and the hazard is silent. A task's body becomes a `switch` inside a
 * `for (;;)`, so a statement emitted as a bare `break` in that position **breaks the switch** — the
 * state machine falls out of its dispatch and the task ends, with no error anywhere. So an `if`
 * holding a jump has to be cut into blocks even when it holds no `await`, which is the only reason
 * `blocksOf` cuts on anything other than suspension.
 */
function containsLoopJump(stmts: readonly IrStmt[]): boolean {
  return stmts.some((stmt) => {
    switch (stmt.kind) {
      case 'loopJump':
        return true;
      case 'if':
      case 'ifLet':
        return containsLoopJump(stmt.then) || (stmt.otherwise !== null && containsLoopJump(stmt.otherwise));
      case 'scope':
        return containsLoopJump(stmt.body);
      default:
        /* `while` and `forQuery` included: a jump inside one is caught by it. */
        return false;
    }
  });
}

/**
 * Cut a rewritten body into blocks.
 *
 * The first block is always index 0, which is where `start` leaves the frame pointing.
 */
export function blocksOf(body: readonly IrStmt[]): Block[] {
  const blocks: Block[] = [];
  const create = (): number => {
    blocks.push({ stmts: [], terminator: { kind: 'done' } });
    return blocks.length - 1;
  };

  /* The cut loops currently open, innermost last. A jump reaching this lowering always belongs to
     one of them: a jump inside a loop that was *not* cut never gets here, because that loop was
     pushed into a block whole and this walk does not descend into it. */
  const loops: { head: number; exit: number }[] = [];

  const lower = (stmts: readonly IrStmt[], from: number): number => {
    let current = from;
    for (const stmt of stmts) {
      if (stmt.kind === 'await') {
        const next = create();
        blocks[current].terminator = {
          kind: 'await',
          clock: stmt.clock,
          duration: stmt.duration,
          next,
        };
        current = next;
        continue;
      }

      if (stmt.kind === 'awaitTask') {
        const next = create();
        blocks[current].terminator = {
          kind: 'awaitTask',
          task: stmt.task,
          owner: stmt.owner,
          args: stmt.args,
          next,
        };
        current = next;
        continue;
      }

      if (stmt.kind === 'return') {
        blocks[current].terminator = { kind: 'done' };
        /* Anything after a `return` is unreachable, and appending it to a block already terminated
           would emit it before the `return` rather than after. A fresh block collects it and is
           never jumped to, so the emitter drops it. */
        current = create();
        continue;
      }

      if (stmt.kind === 'loopJump') {
        const loop = loops[loops.length - 1];
        /* No enclosing cut loop means the checker already refused this with `DS0238` and the module
           will not be emitted. Staying total beats throwing on a body that is already wrong. */
        if (loop !== undefined) {
          blocks[current].terminator = {
            kind: 'jump',
            target: stmt.word === 'break' ? loop.exit : loop.head,
          };
          /* Anything after a jump is unreachable, for the reason `return` gives above: appending it
             to a block already terminated would emit it before the jump rather than after. */
          current = create();
        }
        continue;
      }

      /* Cut on a jump as well as on an await — see `containsLoopJump` for the `switch` that a bare
         `break` would otherwise break instead of the loop. */
      if (stmt.kind === 'if' && (containsAwait([stmt]) || (loops.length > 0 && containsLoopJump([stmt])))) {
        const thenBlock = create();
        const elseBlock = create();
        const join = create();
        blocks[current].terminator = {
          kind: 'branch',
          condition: stmt.condition,
          then: thenBlock,
          otherwise: elseBlock,
        };
        blocks[lower(stmt.then, thenBlock)].terminator = { kind: 'jump', target: join };
        blocks[lower(stmt.otherwise ?? [], elseBlock)].terminator = { kind: 'jump', target: join };
        current = join;
        continue;
      }

      if (stmt.kind === 'scope' && containsAwait([stmt])) {
        /*
         * A scope that spans a suspend is not one block: the create runs where the block opens, the
         * body is cut wherever it suspends, and the leave runs at the end of whatever block the
         * body finished in. A task that returns out of the middle never reaches that leave, which
         * is why every task has a scope of its own that is left however it ends.
         */
        blocks[current].stmts.push({ kind: 'scopeOpen', name: stmt.name, parent: stmt.parent, span: stmt.span });
        const end = lower(stmt.body, current);
        blocks[end].stmts.push({ kind: 'scopeClose', name: stmt.name, span: stmt.span });
        current = end;
        continue;
      }

      if (stmt.kind === 'while' && containsAwait([stmt])) {
        const head = create();
        const body = create();
        const exit = create();
        blocks[current].terminator = { kind: 'jump', target: head };
        blocks[head].terminator = {
          kind: 'branch',
          condition: stmt.condition,
          then: body,
          otherwise: exit,
        };
        /* Pushed around the body only. A jump in the *condition* is not expressible, and one in a
           sibling statement belongs to whatever encloses this loop rather than to it. */
        loops.push({ head, exit });
        blocks[lower(stmt.body, body)].terminator = { kind: 'jump', target: head };
        loops.pop();
        current = exit;
        continue;
      }

      blocks[current].stmts.push(stmt);
    }
    return current;
  };

  const entry = create();
  const last = lower(body, entry);
  blocks[last].terminator = { kind: 'done' };
  return blocks;
}

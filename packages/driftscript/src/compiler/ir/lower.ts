/**
 * The checked syntax tree, lowered to typed IR.
 *
 * Three things happen here and each is something a backend must never have to do:
 *
 * - **Types are attached.** Every node carries the type the checker resolved, so a backend never
 *   consults a symbol table.
 * - **Units are erased.** `30m` becomes `30`; `250ms` becomes `0.25`; `90deg` becomes radians at
 *   the literal. The design requires no runtime representation whatsoever, and the only way to
 *   guarantee that is for the thing a backend receives to have no unit on it. A unit surviving to
 *   codegen would allocate, and the per-frame budget is zero allocations.
 * - **Sugar is expanded.** `a += b` becomes `a = a + b`, so no backend implements compound
 *   assignment. Every form expanded here is a form a second backend gets for free.
 *
 * The cost is that a diagnostic about lowered code would name a construct the user did not write —
 * which is why nothing here reports. Lowering runs only on a module the checker accepted.
 */
import type {
  ComponentDecl,
  DataDecl,
  EditorMeta,
  EntityDecl,
  EnumDecl,
  EventDecl,
  Expr,
  FieldDecl,
  FnDecl,
  Module,
  OnDecl,
  PrefabDecl,
  StateDecl,
  Stmt,
  SystemDecl,
  TaskDecl,
  TypeRef,
  ConstDecl,
} from '../ast.ts';
import type { CheckResult, ImportedScope } from '../check/checker.ts';
import type { Access } from '../check/entities.ts';
import { INTEGERS, type Type } from '../check/types.ts';
import { namespaceOf } from '../namespace.ts';
import type {
  IrComponent,
  IrData,
  IrEntity,
  IrEnum,
  IrEvent,
  IrExpr,
  IrField,
  IrFn,
  IrHandler,
  IrImport,
  IrModule,
  IrOwner,
  IrPrefab,
  IrState,
  IrStmt,
  IrSystem,
  IrTask,
  IrType,
  IrConst,
} from './ir.ts';

/** The compound operators, and the binary operator each expands to. */
const EXPANSION: Readonly<Record<string, string>> = {
  '+=': '+',
  '-=': '-',
  '*=': '*',
  '/=': '/',
};

/**
 * The conversion each unit applies at its literal, and nothing carried past it.
 *
 * Metres, seconds, kilograms, joules, watts, pascals, moles and kelvin are the base units the
 * engine's own APIs already speak, so they convert by one and exist to be *read* rather than
 * converted. Milliseconds, grams, kilojoules and degrees are the spellings people actually write,
 * and each becomes the base unit here — which is what makes `250ms` and `0.25` the same value to
 * every backend.
 *
 * **`degC` carries an offset, and it is the only entry that does.** Celsius is not a scale of
 * kelvin, it is kelvin shifted by 273.15, so a multiplication cannot express it and a table of
 * multiplications would have erased `20degC` to `20`. That the offset exists for exactly one unit
 * is also why `check/units.ts` refuses `degC` in a difference: an offset is right for an absolute
 * value and wrong for a delta, and nothing downstream can tell which was meant.
 *
 * What would make this wrong is a host whose base unit is not the second or the radian. That host
 * supplies its own conversion table; it does not get a unit at runtime either.
 */
const UNIT_SCALE: Readonly<Record<string, { readonly scale: number; readonly offset: number }>> = {
  m: { scale: 1, offset: 0 },
  s: { scale: 1, offset: 0 },
  ms: { scale: 1 / 1000, offset: 0 },
  rad: { scale: 1, offset: 0 },
  deg: { scale: Math.PI / 180, offset: 0 },
  Hz: { scale: 1, offset: 0 },
  kg: { scale: 1, offset: 0 },
  g: { scale: 1 / 1000, offset: 0 },
  mol: { scale: 1, offset: 0 },
  J: { scale: 1, offset: 0 },
  kJ: { scale: 1000, offset: 0 },
  MJ: { scale: 1e6, offset: 0 },
  W: { scale: 1, offset: 0 },
  Pa: { scale: 1, offset: 0 },
  kPa: { scale: 1000, offset: 0 },
  K: { scale: 1, offset: 0 },
  degC: { scale: 1, offset: 273.15 },
};

/**
 * The capability module a query loop is a use of, and the namespace generated code calls it under.
 *
 * Named here rather than spelled at each site because three things have to agree about it: the
 * requirement the linker checks, the namespace `__bind` fills, and the calls the emitter writes.
 */
const ECS_MODULE = 'drift/ecs';
const ECS_ALIAS = 'ecs';

const VOID_IR: IrType = { kind: 'void' };
/** The type a component and field name carry into an `ecs.read` or `ecs.write` call. */
const STRING_IR: IrType = { kind: 'string' };

/**
 * The parameter a component row's world arrives in.
 *
 * Derived from the row's own name rather than being one shared name, so two component parameters
 * do not collide — and suffixed with a character no identifier can carry, so it cannot shadow
 * anything an author wrote.
 */
function worldOfRow(param: string): string {
  return `${param}$world`;
}

/**
 * A module's constants, sorted so that each is written after everything it names.
 *
 * **JavaScript needs this and the language promises the opposite.** `LANGUAGE.md` says declaration
 * order carries no meaning, and it holds for functions because a function declaration hoists; a
 * `const` does not, so one naming a constant declared below it throws at module load with a
 * `ReferenceError` in generated code nobody wrote. Sorting here is what lets the promise stay true
 * in the language while the output stays valid.
 *
 * A depth-first walk with no cycle guard, because the checker already refused a cycle with
 * `DS0240` — and a module that failed to check is never lowered. `seen` is what keeps a diamond
 * from emitting the same constant twice.
 */
function orderedConstants(module: Module, lowering: Lowering): IrConst[] {
  const decls = new Map(
    module.decls.filter((d): d is ConstDecl => d.kind === 'const').map((d) => [d.name, d]),
  );
  const out: IrConst[] = [];
  const seen = new Set<string>();

  const visit = (decl: ConstDecl): void => {
    if (seen.has(decl.name)) return;
    seen.add(decl.name);
    for (const reference of constantNames(decl.value)) {
      const dependency = decls.get(reference);
      /* An imported constant is not in this map and needs no ordering: it arrives through an ES
         import, which is evaluated before this module's body runs. */
      if (dependency !== undefined) visit(dependency);
    }
    const value = lowering.expr(decl.value);
    out.push({ name: decl.name, value, type: value.type, span: decl.span });
  };

  for (const decl of decls.values()) visit(decl);
  return out;
}

/** The identifiers a constant's value names. Mirrors the checker's own walk over the same forms. */
function constantNames(expr: Expr): string[] {
  switch (expr.kind) {
    case 'ident':
      return [expr.name];
    case 'unary':
      return constantNames(expr.operand);
    case 'binary':
      return [...constantNames(expr.left), ...constantNames(expr.right)];
    default:
      return [];
  }
}

function irTypeOf(type: Type | undefined): IrType {
  if (type === undefined) return VOID_IR;
  switch (type.kind) {
    case 'data':
      return { kind: 'data', name: type.name };
    case 'entity':
      return { kind: 'entity' };
    case 'enum':
      return { kind: 'enum', name: type.name };
    case 'list':
      return { kind: 'list', of: irTypeOf(type.of) };
    case 'option':
      return { kind: 'option', inner: irTypeOf(type.inner) };
    case 'result':
      return { kind: 'result', ok: irTypeOf(type.ok), err: irTypeOf(type.err) };
    case 'primitive':
      if (type.name === 'f64') return { kind: 'f64' };
      if (type.name === 'bool') return { kind: 'bool' };
      if (type.name === 'String') return { kind: 'string' };
      if (type.name === 'f32') return { kind: 'f32' };
      /*
       * Integer widths are carried rather than collapsed.
       *
       * The width is a *checking* distinction over one JavaScript number, so it costs nothing at
       * runtime — but the backend needs it, because `a + b` on `u8` emits an overflow check whose
       * bounds depend on the width. Collapsing here would push that lookup back into the checker's
       * territory or lose it entirely.
       */
      return { kind: 'int', name: type.name };
    case 'void':
    case 'error':
      return VOID_IR;
  }
}

/** The value a field with no declared default starts at. */
function zeroFor(type: IrType): number | string | boolean {
  switch (type.kind) {
    case 'string':
      return '';
    case 'bool':
      return false;
    default:
      return 0;
  }
}

class Lowering {
  private readonly checked: CheckResult;
  /** The query loops currently open, innermost last. See `componentAccess`. */
  private readonly loops: { binding: string; depth: number; views: readonly string[] }[] = [];

  /**
   * Every open loop, of either kind, innermost last — which `loops` above is not.
   *
   * `loops` holds query loops only, because it exists to resolve `<binding>.<Component>`. A jump
   * needs the innermost loop of *any* kind, so that a `break` inside a `while` nested in a query
   * loop leaves the `while` and does not drain a cursor it is not finished with. Two stacks rather
   * than one with a filter, because the two questions are different and a shared stack answered the
   * wrong one for whichever caller was written second.
   */
  private readonly enclosing: ({ kind: 'query'; depth: number } | { kind: 'while' })[] = [];
  /** This module's identity, which every field it declares carries into its id. */
  private readonly moduleId: string;
  /** Event declarations by name, so an `emit` can be filled out in declaration order. */
  private readonly events = new Map<string, IrEvent>();
  /** The `scope` blocks enclosing the statement being lowered, innermost last. */
  private readonly scopes: string[] = [];
  private inTask = false;

  constructor(checked: CheckResult, moduleId = '') {
    this.checked = checked;
    this.moduleId = moduleId;
  }

  private typeOf(expr: Expr): IrType {
    return irTypeOf(this.checked.types.get(expr));
  }

  private resolveRef(ref: TypeRef): IrType {
    if (ref.kind === 'option') return { kind: 'option', inner: this.resolveRef(ref.inner) };
    if (ref.name === 'Result' && ref.args.length === 2) {
      return { kind: 'result', ok: this.resolveRef(ref.args[0]), err: this.resolveRef(ref.args[1]) };
    }
    const declared = this.checked.data.get(ref.name) ?? this.checked.enums.get(ref.name);
    if (declared !== undefined) return irTypeOf(declared);
    return irTypeOf({ kind: 'primitive', name: ref.name });
  }

  expr(node: Expr): IrExpr {
    const type = this.typeOf(node);

    switch (node.kind) {
      case 'number': {
        const unit = node.unit === undefined ? undefined : UNIT_SCALE[node.unit];
        const value = unit === undefined ? node.value : node.value * unit.scale + unit.offset;
        return { kind: 'const', value, type, span: node.span };
      }
      case 'string':
      case 'bool':
        return { kind: 'const', value: node.value, type, span: node.span };
      case 'ident':
        if (node.name === 'none') {
          return { kind: 'wrap', tag: 'none', value: null, type, span: node.span };
        }
        return { kind: 'local', name: node.name, type, span: node.span };
      case 'member': {
        /*
         * `e.Hunger.value` is not a property chain and is lowered as one node.
         *
         * The shape is a member whose *target* is a member on a query binding. A handle has no
         * `.Hunger` and a component is not a value, so emitting the chain literally would produce
         * JavaScript that reads a property of a number.
         */
        const component = this.componentAccess(node.target);
        if (component !== null) {
          return {
            kind: 'componentField',
            depth: component.depth,
            view: component.view,
            field: node.name,
            type,
            span: node.span,
          };
        }
        /*
         * A handle no loop bound reads through `drift/ecs` rather than as a property.
         *
         * Falling through to `field` below is what this repairs: `who.Placement.x` outside a query loop
         * emitted `who.Placement.x`, a property read of a number, which type-checked and threw. See
         * `CheckResult.componentWorlds`.
         */
        const byHandle = this.handleRead(node);
        if (byHandle !== null) return byHandle;
        const byRow = this.rowRead(node);
        if (byRow !== null) return byRow;
        return {
          kind: 'field',
          target: this.expr(node.target),
          name: node.name,
          type,
          span: node.span,
        };
      }
      case 'optionalMember':
        return {
          kind: 'optionalField',
          target: this.expr(node.target),
          name: node.name,
          type,
          span: node.span,
        };
      case 'unary': {
        const operand = this.expr(node.operand);
        /*
         * **A negated literal is a constant, and folding it here is what makes it one.**
         *
         * `-0.55` parses as a unary minus over a literal, so without this it lowers to a `unary`
         * node — and every consumer asking "is this constant?" answers no. A prefab is the one
         * that bites: `lower.prefab` keeps only `const` values and drops the rest, so
         * `Spin { rate: -0.55 }` emitted a prefab with **no rate at all** and the entity span
         * silently at zero. Nothing reported it, because the refusal the comment there defers to
         * the checker was never a refusal — the value was well-formed.
         *
         * Found by the first script to put a negative number in a prefab.
         */
        if (node.op === '-' && operand.kind === 'const' && typeof operand.value === 'number') {
          return { kind: 'const', value: -operand.value, type, span: node.span };
        }
        return {
          kind: 'unary',
          op: node.op,
          operand,
          type,
          span: node.span,
        };
      }
      case 'binary':
        return {
          kind: 'binary',
          op: node.op,
          left: this.expr(node.left),
          right: this.expr(node.right),
          type,
          span: node.span,
        };
      case 'call': {
        /* An enum constructor's callee is a member — `Shape.Circle` — and lowers to the dotted name
           the backend emits. Every other callee is a plain identifier. */
        const name =
          node.callee.kind === 'ident'
            ? node.callee.name
            : node.callee.kind === 'member' && node.callee.target.kind === 'ident'
              ? `${node.callee.target.name}.${node.callee.name}`
              : '<invalid>';
        if (name === 'Ok' || name === 'Err' || name === 'some') {
          return { kind: 'wrap', tag: name, value: this.expr(node.args[0]), type, span: node.span };
        }
        /*
         * An argument in a component-parameter position becomes two, matching the callee's own
         * expansion: the world the row is read from, and the handle it belongs to. The argument is
         * always `<entity>.<Component>` — the checker refused anything else — so both are in hand.
         */
        const signature = this.checked.functions.get(name);
        const args: IrExpr[] = [];
        node.args.forEach((argument, index) => {
          const parameter = signature?.params[index];
          if (parameter?.component !== undefined && argument.kind === 'member') {
            const world = this.checked.componentWorlds.get(argument);
            args.push({
              kind: 'local',
              name: world ?? 'world',
              type: { kind: 'data', name: 'World' },
              span: argument.span,
            });
            args.push(this.expr(argument.target));
            return;
          }
          args.push(this.expr(argument));
        });
        return {
          kind: 'call',
          callee: name,
          args,
          rounds: this.checked.rounded.has(node),
          type,
          span: node.span,
        };
      }
      case 'listLiteral':
        return {
          kind: 'listLiteral',
          items: node.items.map((item) => this.expr(item)),
          type,
          span: node.span,
        };
      case 'index':
        return {
          kind: 'index',
          target: this.expr(node.target),
          at: this.expr(node.at),
          type,
          span: node.span,
        };
      case 'record':
        return {
          kind: 'record',
          name: node.name,
          fields: node.fields.map((f) => ({ name: f.name, value: this.expr(f.value) })),
          type,
          span: node.span,
        };
      case 'try':
        return { kind: 'try', inner: this.expr(node.inner), type, span: node.span };
      case 'match':
        return {
          kind: 'match',
          subject: this.expr(node.subject),
          arms: node.arms.map((arm) => ({
            variant: arm.pattern.kind === 'wildcard' ? null : arm.pattern.name,
            binding: arm.pattern.kind === 'wildcard' ? null : (arm.pattern.binding ?? null),
            body: this.expr(arm.body),
            span: arm.span,
          })),
          type,
          span: node.span,
        };
    }
  }

  /**
   * Where `<binding>.<Component>` sits among the enclosing loops' views, or null.
   *
   * Matched on the shape and resolved against the loops currently open, which is why lowering keeps
   * a stack of them: the component named has to belong to the loop that bound *that* name, and a
   * nested loop does not take the outer binding's components away.
   */
  /**
   * `<handle>.<Component>.<field>` as an `ecs.read`, or null when this is not that shape.
   *
   * Built as an ordinary call rather than as a node of its own, because that is all it is: the
   * backend already emits a dotted callee through the bound namespace, so there is nothing for a
   * new IR kind to carry that a call does not.
   */
  private handleRead(node: Extract<Expr, { kind: 'member' }>): IrExpr | null {
    if (node.target.kind !== 'member') return null;
    const world = this.checked.componentWorlds.get(node.target);
    if (world === undefined) return null;
    const type = this.typeOf(node);
    return {
      kind: 'call',
      callee: `${ECS_ALIAS}.read`,
      args: [
        { kind: 'local', name: world, type: { kind: 'data', name: 'World' }, span: node.span },
        this.expr(node.target.target),
        { kind: 'const', value: node.target.name, type: STRING_IR, span: node.span },
        { kind: 'const', value: node.name, type: STRING_IR, span: node.span },
      ],
      rounds: false,
      type,
      span: node.span,
    };
  }

  /**
   * `<handle>.<Component>.<field> = v` as an `ecs.write`, or null when this is not that shape.
   *
   * A statement rather than an expression, because a write through a handle is a call and there is
   * nothing to assign to — which is exactly why the old fall-through was wrong: it produced
   * `who.Placement.x = v`, an assignment to a property of a number, which throws.
   */
  private handleWrite(target: Expr, value: Expr): IrStmt | null {
    if (target.kind !== 'member') return null;
    const row = this.checked.rowFields.get(target);
    if (row !== undefined) {
      return {
        kind: 'expr',
        expr: {
          kind: 'call',
          callee: `${ECS_ALIAS}.write`,
          args: [
            { kind: 'local', name: worldOfRow(row.param), type: { kind: 'data', name: 'World' }, span: target.span },
            { kind: 'local', name: row.param, type: { kind: 'entity' }, span: target.span },
            { kind: 'const', value: row.component, type: STRING_IR, span: target.span },
            { kind: 'const', value: target.name, type: STRING_IR, span: target.span },
            this.expr(value),
          ],
          rounds: false,
          type: VOID_IR,
          span: target.span,
        },
        span: target.span,
      };
    }
    if (target.target.kind !== 'member') return null;
    /*
     * **A loop view wins, and this test is what keeps it.** `componentWorlds` records every
     * component access, including the ones a query loop resolves, because a row handed to a
     * function needs its world at the call site too. Without this line a write inside a query loop
     * took the `ecs.write` path instead of `$v.field[$i] = …` — a host call per field per entity
     * per frame, which is the whole cost the view exists to remove. Caught by the query emit tests
     * within a minute; it would have been invisible in a diagnostic.
     */
    if (this.componentAccess(target.target) !== null) return null;
    const world = this.checked.componentWorlds.get(target.target);
    if (world === undefined) return null;
    return {
      kind: 'expr',
      expr: {
        kind: 'call',
        callee: `${ECS_ALIAS}.write`,
        args: [
          { kind: 'local', name: world, type: { kind: 'data', name: 'World' }, span: target.span },
          this.expr(target.target.target),
          { kind: 'const', value: target.target.name, type: STRING_IR, span: target.span },
          { kind: 'const', value: target.name, type: STRING_IR, span: target.span },
          this.expr(value),
        ],
        rounds: false,
        type: VOID_IR,
        span: target.span,
      },
      span: target.span,
    };
  }

  /** `<row>.<field>` on a component parameter, as an `ecs.read` against the row's own world. */
  private rowRead(node: Extract<Expr, { kind: 'member' }>): IrExpr | null {
    const row = this.checked.rowFields.get(node);
    if (row === undefined) return null;
    return {
      kind: 'call',
      callee: `${ECS_ALIAS}.read`,
      args: [
        { kind: 'local', name: worldOfRow(row.param), type: { kind: 'data', name: 'World' }, span: node.span },
        { kind: 'local', name: row.param, type: { kind: 'entity' }, span: node.span },
        { kind: 'const', value: row.component, type: STRING_IR, span: node.span },
        { kind: 'const', value: node.name, type: STRING_IR, span: node.span },
      ],
      rounds: false,
      type: this.typeOf(node),
      span: node.span,
    };
  }

  private componentAccess(node: Expr): { depth: number; view: number } | null {
    if (node.kind !== 'member' || node.target.kind !== 'ident') return null;
    const binding = node.target.name;
    for (let i = this.loops.length - 1; i >= 0; i -= 1) {
      const loop = this.loops[i] as { binding: string; depth: number; views: readonly string[] };
      if (loop.binding !== binding) continue;
      const view = loop.views.indexOf(node.name);
      return view < 0 ? null : { depth: loop.depth, view };
    }
    return null;
  }

  stmt(node: Stmt): IrStmt {
    switch (node.kind) {
      case 'let': {
        const value = this.expr(node.value);
        return { kind: 'let', name: node.name, value, type: value.type, span: node.span };
      }
      case 'assign': {
        const written = this.handleWrite(node.target, node.value);
        if (written !== null) return written;
        return {
          kind: 'assign',
          target: this.expr(node.target),
          value: this.expr(node.value),
          span: node.span,
        };
      }
      case 'forQuery': {
        /*
         * The plan is read rather than re-derived. Only the checker knows what an `entity` term
         * expands to and which components the body writes, and a lowering that decided either
         * would be a second answer to one question.
         *
         * A missing plan means the checker refused this loop — an unknown component, say — so
         * nothing here is reachable in a module that compiles. Lowering it as an empty query keeps
         * this total rather than throwing, and the diagnostics are what a caller sees.
         */
        const plan = this.checked.queries.get(node);
        const views = plan?.views ?? [];
        const depth = this.loops.length;
        /* Pushed before the body is lowered, because every `<binding>.<Component>` inside it
           resolves against this loop — and popped after, so a sibling loop does not see it. */
        this.loops.push({
          binding: node.binding,
          depth,
          views: views.map((view) => view.component),
        });
        this.enclosing.push({ kind: 'query', depth });
        const body = node.body.map((stmt) => this.stmt(stmt));
        this.enclosing.pop();
        this.loops.pop();
        return {
          kind: 'forQuery',
          binding: node.binding,
          depth,
          world: plan?.world ?? '',
          required: plan?.required ?? [],
          excluded: plan?.excluded ?? [],
          views,
          body,
          span: node.span,
        };
      }
      case 'compoundAssign': {
        /* `a += b` becomes `a = a + b`, so no backend implements compound assignment. The target is
           lowered once and shared by both sides, which is safe because this language has no
           side-effecting expression that could make evaluating it twice differ — and would stop
           being safe the moment it does, which is why a call is not a valid assignment target. */
        const target = this.expr(node.target);
        const value = this.expr(node.value);
        return {
          kind: 'assign',
          target,
          value: {
            kind: 'binary',
            op: EXPANSION[node.op] ?? node.op,
            left: target,
            right: value,
            type: target.type,
            span: node.span,
          },
          span: node.span,
        };
      }
      case 'return':
        return {
          kind: 'return',
          value: node.value === undefined ? null : this.expr(node.value),
          span: node.span,
        };
      case 'if':
        return {
          kind: 'if',
          condition: this.expr(node.condition),
          then: node.then.map((s) => this.stmt(s)),
          otherwise: node.otherwise === undefined ? null : node.otherwise.map((s) => this.stmt(s)),
          span: node.span,
        };
      case 'ifLet':
        return {
          kind: 'ifLet',
          name: node.name,
          subject: this.expr(node.subject),
          then: node.then.map((s) => this.stmt(s)),
          otherwise: node.otherwise === undefined ? null : node.otherwise.map((s) => this.stmt(s)),
          span: node.span,
        };
      case 'while': {
        /* The condition is lowered outside the push: a `while` in a condition is not a thing, but
           keeping the order explicit means a future expression form containing a jump cannot pick
           this loop up by accident. */
        const condition = this.expr(node.condition);
        this.enclosing.push({ kind: 'while' });
        const body = node.body.map((s) => this.stmt(s));
        this.enclosing.pop();
        return { kind: 'while', condition, body, span: node.span };
      }
      case 'forList': {
        /* Numbered by the same depth counter a query loop uses, so a list walk inside a query loop
           and a query loop inside a list walk both get distinct temporaries. */
        const depth = this.enclosing.length;
        const subject = this.expr(node.subject);
        this.enclosing.push({ kind: 'while' });
        const body = node.body.map((s) => this.stmt(s));
        this.enclosing.pop();
        return { kind: 'forList', binding: node.binding, subject, depth, body, span: node.span };
      }
      case 'loopJump': {
        const inner = this.enclosing[this.enclosing.length - 1];
        /* A `break` out of a query loop drains its cursor; everything else jumps and nothing more.
           An absent loop means the checker already reported `DS0238`, and lowering stays total. */
        const drain =
          node.word === 'break' && inner !== undefined && inner.kind === 'query' ? inner.depth : null;
        return { kind: 'loopJump', word: node.word, drain, span: node.span };
      }
      case 'await':
        return {
          kind: 'await',
          clock: node.clock,
          duration: this.expr(node.duration),
          span: node.span,
        };
      case 'become':
        return { kind: 'become', state: node.state, inEntry: this.inTask, span: node.span };
      case 'awaitTask':
        return {
          kind: 'awaitTask',
          task: node.task,
          owner: this.owner(),
          args: node.args.map((a) => this.expr(a)),
          span: node.span,
        };
      case 'emit': {
        /*
         * Fields come out in the event's declaration order with defaults filled in, rather than in
         * the order somebody wrote them. Two emits of one event then build the same shape, which is
         * what lets an engine hold one hidden class per event rather than one per call site.
         */
        const declared = this.events.get(node.event);
        const written = new Map(node.fields.map((f) => [f.name, this.expr(f.value)]));
        const fields =
          declared === undefined
            ? node.fields.map((f) => ({ name: f.name, value: this.expr(f.value) }))
            : declared.fields.map((field) => ({
                name: field.name,
                value: written.get(field.name) ?? field.init,
              }));
        return { kind: 'emit', event: node.event, fields, span: node.span };
      }
      case 'spawn':
        return {
          kind: 'spawn',
          task: node.task,
          owner: this.owner(),
          args: node.args.map((a) => this.expr(a)),
          span: node.span,
        };
      case 'scope': {
        const parent = this.owner();
        this.scopes.push(node.name);
        const body = node.body.map((s) => this.stmt(s));
        this.scopes.pop();
        return { kind: 'scope', name: node.name, parent, body, span: node.span };
      }
      case 'expr':
        return { kind: 'expr', expr: this.expr(node.expr), span: node.span };
    }
  }

  /** What encloses the statement being lowered: the nearest `scope`, else the task, else the module. */
  private owner(): IrOwner {
    const innermost = this.scopes[this.scopes.length - 1];
    if (innermost !== undefined) return { kind: 'scope', name: innermost };
    return this.inTask ? { kind: 'task' } : { kind: 'module' };
  }

  data(decl: DataDecl, inherited: readonly IrField[] = []): IrData {
    /*
     * Inherited fields first, then this record's own — the layout the checker settled on and the
     * order `__drift.shapes` carries. They arrive already lowered, from wherever the base was
     * declared, because their default expressions belong to that file and only that file's types
     * can lower them. Rebuilding them here from the base's *type* would lose the defaults and
     * substitute zeroes: a wrong value rather than an error.
     */
    const fields: IrField[] = [...inherited];
    for (const field of decl.fields) {
      const type = this.resolveRef(field.type);
      fields.push({
        name: field.name,
        type,
        init:
          field.default !== undefined
            ? this.expr(field.default)
            : { kind: 'const', value: zeroFor(type), type, span: field.span },
        /* This record declares it, so the id is keyed here. Inherited fields above kept the owner
           they were lowered with, in the file that declared them. */
        owner: `${this.moduleId}::${decl.name}`,
        /* `@id("phase")` keeps the old name in the id after a rename, so a migration still finds
           the value. Absent, the id is built from the field's current name. */
        pinned: field.id,
      });
    }
    return { name: decl.name, fields, span: decl.span };
  }

  /**
   * A component's fields, lowered exactly as a record's are.
   *
   * The owner is `<module>::<Component>`, so a language-declared component's field ids carry the
   * file that declared them — which is the whole reason `defineComponent` gained a schema overload.
   */
  private componentFields(name: string, fields: readonly FieldDecl[]): IrField[] {
    return fields.map((field) => {
      const type = this.resolveRef(field.type);
      return {
        name: field.name,
        type,
        init:
          field.default !== undefined
            ? this.expr(field.default)
            : { kind: 'const' as const, value: zeroFor(type), type, span: field.span },
        owner: `${this.moduleId}::${name}`,
        pinned: field.id,
      };
    });
  }

  component(decl: ComponentDecl): IrComponent {
    const editor: Record<string, EditorMeta> = {};
    for (const field of decl.fields) if (field.editor !== undefined) editor[field.name] = field.editor;
    return {
      name: decl.name,
      fromHost: decl.fromHost,
      fields: this.componentFields(decl.name, decl.fields),
      editor,
      span: decl.span,
    };
  }

  /** An entity's implicit component: its own `var` fields, under its own name. */
  entityComponent(decl: EntityDecl): IrComponent {
    const editor: Record<string, EditorMeta> = {};
    for (const field of decl.fields) if (field.editor !== undefined) editor[field.name] = field.editor;
    return {
      name: decl.name,
      fromHost: false,
      fields: this.componentFields(decl.name, decl.fields),
      editor,
      span: decl.span,
    };
  }

  entity(decl: EntityDecl): IrEntity {
    return {
      name: decl.name,
      requires: decl.requires.map((required) => required.name),
      ownComponent: decl.fields.length === 0 ? null : decl.name,
      span: decl.span,
    };
  }

  system(decl: SystemDecl, access: Access | undefined): IrSystem {
    /*
     * **What was inferred, plus what was declared** — and the union is the half that took a bug to
     * find.
     *
     * This used to be the inferred sets alone, on the reasoning that a declaration is an assertion
     * the checker verified and the engine needs the truth. That is right whenever the compiler can
     * see the access, and it is wrong exactly where it cannot: a capability naming a component with
     * a *string* — `ecs.read(world, e, "Position", "x")`, or a host's spatial query — is invisible
     * to inference, so the component never reached the metadata, and a host that enforces declared
     * access refused the call at runtime. There was no way for the author to grant it: writing
     * `reads Position` was checked and then dropped.
     *
     * So a declaration now *adds*. Under-declaring is still an error, so this cannot hide a
     * mistake; over-declaring costs a scheduler that serialises two systems it could have run
     * together, which is the safe direction to be wrong in.
     *
     * A system with no clauses is still fully described by inference alone, which is what keeps the
     * quiet form quiet.
     */
    const reads = new Set([...(access?.reads ?? []), ...decl.reads.map((r) => r.name)]);
    const writes = new Set([...(access?.writes ?? []), ...decl.writes.map((w) => w.name)]);
    /* A declared write is a declared read, matching `checkSystemDeclarations` and the engine. */
    for (const written of writes) reads.add(written);

    return {
      name: decl.name,
      reads: [...reads],
      writes: [...writes],
      /* Resolved by the checker rather than reprinted from the annotation here — see
         `CheckResult.systemResources`. A system whose head was refused contributes none. */
      uses: this.checked.systemResources.get(decl.name) ?? [],
      after: decl.after.map((a) => a.name),
      everyTicks: decl.everyTicks,
      body: decl.body.map((s) => this.stmt(s)),
      span: decl.span,
    };
  }

  prefab(decl: PrefabDecl): IrPrefab {
    return {
      name: decl.name,
      components: decl.components.map((component) => {
        const values: Record<string, number | string | boolean> = {};
        for (const value of component.values) {
          const lowered = this.expr(value.value);
          /*
           * Only a constant reaches a prefab, and a non-constant is dropped rather than emitted.
           *
           * A prefab is a description the host instantiates from data it holds — a value computed
           * at spawn time would make it a program. The checker is what reports the refusal; this
           * drops what it refused so a module that failed to check does not emit something a host
           * would try to run.
           */
          if (lowered.kind === 'const') values[value.name] = lowered.value;
        }
        return { name: component.name, values };
      }),
      span: decl.span,
    };
  }

  enumeration(decl: EnumDecl): IrEnum {
    return {
      name: decl.name,
      variants: decl.variants.map((v) => ({ name: v.name, hasPayload: v.payload !== undefined })),
      span: decl.span,
    };
  }

  event(decl: EventDecl): IrEvent {
    const lowered: IrEvent = {
      name: decl.name,
      fields: decl.fields.map((field) => {
        const type = this.resolveRef(field.type);
        return {
          name: field.name,
          type,
          /* A field with no default gets the zero for its type, exactly as a record's does — so an
             `emit` that omits one is a diagnostic rather than an `undefined` in a payload. The
             checker refuses it; this is what the backend would build if it did not. */
          init:
            field.default !== undefined
              ? this.expr(field.default)
              : { kind: 'const', value: zeroFor(type), type, span: field.span },
          owner: `${this.moduleId}::${decl.name}`,
        };
      }),
      span: decl.span,
    };
    this.events.set(decl.name, lowered);
    return lowered;
  }

  handler(decl: OnDecl, index: number): IrHandler {
    return {
      name: `$on_${decl.event}_${index}`,
      event: decl.event,
      binding: decl.binding,
      body: decl.body.map((s) => this.stmt(s)),
      span: decl.span,
    };
  }

  state(decl: StateDecl): IrState {
    let enter: IrTask | null = null;
    if (decl.enter !== undefined) {
      this.inTask = true;
      enter = {
        name: `${decl.name}.enter`,
        annotations: [],
        params: [],
        body: decl.enter.map((s) => this.stmt(s)),
        span: decl.span,
      };
      this.inTask = false;
    }
    return {
      name: decl.name,
      enter,
      handlers: decl.handlers.map((handler) => ({
        event: handler.event,
        binding: handler.binding ?? null,
        body: handler.body.map((s) => this.stmt(s)),
      })),
      span: decl.span,
    };
  }

  task(decl: TaskDecl): IrTask {
    this.inTask = true;
    const lowered = this.taskBody(decl);
    this.inTask = false;
    return lowered;
  }

  private taskBody(decl: TaskDecl): IrTask {
    return {
      name: decl.name,
      annotations: decl.annotations,
      params: decl.params.map((p) => ({ name: p.name, type: this.resolveRef(p.type) })),
      body: decl.body.map((s) => this.stmt(s)),
      span: decl.span,
    };
  }

  fn(decl: FnDecl): IrFn {
    /*
     * **A component parameter is two parameters by the time a backend sees it.**
     *
     * A row is not a value — its fields are columns in a world — so what a caller actually lends is
     * the world and the handle, and `m.x` inside the body is the same `ecs.read` a handle access
     * compiles to. Expanded here rather than given a parameter kind of its own, because every
     * backend would otherwise have to know what a row is; expanded this way, none of them does.
     *
     * The world takes the parameter's own name with a suffix, so two component parameters cannot
     * collide and neither can shadow a name the author wrote.
     */
    const params: { name: string; type: IrType }[] = [];
    for (const p of decl.params) {
      const component = this.componentParamOf(decl, p.name);
      if (component !== null) {
        params.push({ name: worldOfRow(p.name), type: { kind: 'data', name: 'World' } });
        params.push({ name: p.name, type: { kind: 'entity' } });
        continue;
      }
      params.push({ name: p.name, type: this.resolveRef(p.type) });
    }
    return {
      name: decl.name,
      annotations: decl.annotations,
      params,
      returns: decl.returnType === undefined ? VOID_IR : this.resolveRef(decl.returnType),
      body: decl.body.map((s) => this.stmt(s)),
      span: decl.span,
    };
  }

  /** The component a function's parameter is a row of, from the checked signature. */
  private componentParamOf(decl: FnDecl, name: string): string | null {
    const signature = this.checked.functions.get(decl.name);
    const param = signature?.params.find((p) => p.name === name);
    return param?.component ?? null;
  }
}

/** Whether an IR type is an integer, which the backend needs for its overflow checks. */
export function isIntegerIr(type: IrType): boolean {
  return type.kind === 'int' && INTEGERS.has(type.name);
}

export function lower(
  module: Module,
  checked: CheckResult,
  /** What this module imported, so an import can be classified as a value or erased as a type. */
  imported?: ImportedScope,
  /** The lowered fields of records this module imports, so a subtype can inline its base's defaults. */
  inheritedFields?: ReadonlyMap<string, readonly IrField[]>,
  /** Every capability the imported files require, so this module's `requires` is the closure. */
  transitiveRequires?: readonly string[],
  /** This module's identity, which every field it declares carries into its id. */
  moduleId?: string,
): IrModule {
  const lowering = new Lowering(checked, moduleId);

  /* Deduplicated but order-preserving: a module imported twice is one requirement, and the linker
     reports refusals in the order a reader will find them in the file. A `Set` alone would give the
     first, and sorting would give neither. */
  /* Seeded with what the imports require, so `requires` is the transitive closure the linker needs
     rather than only what this file names. Order still follows the file: a reader meets refusals in
     the order the imports appear. */
  const requires: string[] = [...(transitiveRequires ?? [])];
  const imports: IrImport[] = [];
  for (const decl of module.imports) {
    if (!decl.relative) {
      if (!requires.includes(decl.module)) requires.push(decl.module);
      continue;
    }

    /* Enums and functions exist at runtime; a record does not, under the name a script wrote. See
       `IrImport.values`. A name the scope does not know is left out rather than guessed — it has
       already been refused as DS0502, and emitting an import for it would turn a diagnostic into a
       module that fails to load. */
    const values = decl.names.filter(
      (name) =>
        imported?.enums.has(name) === true ||
        imported?.functions.has(name) === true ||
        imported?.constants.has(name) === true,
    );

    /* Two imports of one file merge into one emitted import, because two `import` statements from
       the same specifier is output nobody writes by hand and a reader would ask why. */
    const at = imports.findIndex((i) => i.module === decl.module);
    if (at < 0) imports.push({ module: decl.module, values });
    else {
      const merged = [...imports[at].values];
      for (const value of values) if (!merged.includes(value)) merged.push(value);
      imports[at] = { module: decl.module, values: merged };
    }
  }

  /* One namespace per module, keyed by the last path segment — the same binding the checker made.
     Deduplicated because two imports of one module are one namespace. */
  const namespaces: { alias: string; module: string }[] = [];
  for (const decl of module.imports) {
    /*
     * A **file** import binds no namespace, and emitting one is dead code in every cross-module
     * output. `import { Wave } from "./shapes"` names a type or a value that arrives as an ordinary
     * ES import; there is no host that could supply `./shapes`, and `bindModule` does not even look
     * for one because it only checks `drift/` requirements. Found by reading what the dev server
     * actually served rather than by a failing test, which is why the assertion beside it now says
     * so out loud.
     */
    if (decl.relative) continue;
    const alias = decl.alias ?? namespaceOf(decl.module);
    if (namespaces.some((n) => n.alias === alias)) continue;
    namespaces.push({ alias, module: decl.module });
  }

  /*
   * A query loop requires `drift/ecs` whether or not the file imports anything from it.
   *
   * The form *is* a use of that capability — it opens a cursor, walks it and takes views — so a
   * module holding one has the requirement, and the linker refusing it against a target that does
   * not provide the entity model is the correct and intended behaviour rather than an edge case.
   * Adding it here rather than asking an author to write an import they never call keeps the form
   * self-contained: `for e in query<…>()` works on its own, the way `emit` does.
   *
   * The namespace is added for the same reason. Generated code reaches a host through
   * `__bind($host)` and nothing else, so without an entry there is no `ecs` to call.
   */
  /* A handle-based component access is a use of `drift/ecs` for exactly the reason a query loop is:
     it compiles to `ecs.read` and `ecs.write`, so the module has the requirement and needs the
     namespace bound whether or not the file imports anything from it. */
  if (checked.queries.size > 0 || checked.componentWorlds.size > 0) {
    if (!requires.includes(ECS_MODULE)) requires.push(ECS_MODULE);
    if (!namespaces.some((n) => n.module === ECS_MODULE)) {
      namespaces.push({ alias: ECS_ALIAS, module: ECS_MODULE });
    }
  }

  /*
   * Records lower base-first, memoised, because a subtype splices its base's lowered fields and a
   * base may be declared after it. Declaration order does not decide base resolution in the checker
   * and must not decide it here either. Cycles cannot arise: the checker refused them before this
   * runs, and `Type.base` is only set for a clause that resolved.
   */
  const declared = new Map<string, DataDecl>();
  for (const decl of module.decls) if (decl.kind === 'data') declared.set(decl.name, decl);

  const loweredData = new Map<string, IrData>();
  const lowerRecord = (decl: DataDecl): IrData => {
    const done = loweredData.get(decl.name);
    if (done !== undefined) return done;

    let inherited: readonly IrField[] = [];
    if (decl.base !== undefined) {
      const local = declared.get(decl.base.name);
      inherited =
        local !== undefined ? lowerRecord(local).fields : (inheritedFields?.get(decl.base.name) ?? []);
    }

    const result = lowering.data(decl, inherited);
    loweredData.set(decl.name, result);
    return result;
  };

  /*
   * Events are lowered **before** anything that can contain an `emit`, and the order is the point.
   * Filling an emit out needs the declaration's field order and defaults, and the properties of the
   * object below are evaluated top to bottom — so lowering events inline there would lower every
   * function body first, against an empty table. That failure is silent: the emit falls back to the
   * fields somebody wrote, in the order they wrote them, with no defaults.
   */
  const events = module.decls.filter((d) => d.kind === 'event').map((d) => lowering.event(d));
  const constants = orderedConstants(module, lowering);

  /* An entity's own fields are a component like any other, so the two lists are built together —
     a host reading `components` finds every store it has to make, without knowing which form
     declared it. */
  const components = [
    ...module.decls
      .filter((d): d is ComponentDecl => d.kind === 'component')
      .map((d) => lowering.component(d)),
    ...module.decls
      .filter((d): d is EntityDecl => d.kind === 'entity' && d.fields.length > 0)
      .map((d) => lowering.entityComponent(d)),
  ];

  return {
    namespaces,
    components,
    entities: module.decls
      .filter((d): d is EntityDecl => d.kind === 'entity')
      .map((d) => lowering.entity(d)),
    systems: module.decls
      .filter((d): d is SystemDecl => d.kind === 'system')
      .map((d) => lowering.system(d, checked.access.get(d.name))),
    prefabs: module.decls
      .filter((d): d is PrefabDecl => d.kind === 'prefab')
      .map((d) => lowering.prefab(d)),
    data: module.decls.filter((d) => d.kind === 'data').map((d) => lowerRecord(d)),
    enums: module.decls.filter((d) => d.kind === 'enum').map((d) => lowering.enumeration(d)),
    constants,
    fns: module.decls.filter((d) => d.kind === 'fn').map((d) => lowering.fn(d)),
    events,
    tasks: module.decls.filter((d) => d.kind === 'task').map((d) => lowering.task(d)),
    handlers: module.decls
      .filter((d) => d.kind === 'on')
      .map((d, index) => lowering.handler(d, index)),
    states: module.decls.filter((d) => d.kind === 'state').map((d) => lowering.state(d)),
    requires,
    imports,
  };
}

/**
 * Lower a module's records and nothing else.
 *
 * What another module needs in order to extend one of these is the fields, in order, with their
 * default expressions — and those expressions can only be lowered by the file that declared them,
 * because that is where their types were checked. Functions are not lowered because their bodies
 * were never checked: `collect` deliberately stops short of that, and lowering an unchecked body
 * would read types that are not there.
 */
export function lowerRecords(
  module: Module,
  checked: CheckResult,
  inheritedFields?: ReadonlyMap<string, readonly IrField[]>,
  moduleId?: string,
): ReadonlyMap<string, readonly IrField[]> {
  const lowering = new Lowering(checked, moduleId);
  const declared = new Map<string, DataDecl>();
  for (const decl of module.decls) if (decl.kind === 'data') declared.set(decl.name, decl);

  const out = new Map<string, readonly IrField[]>();
  const lowerRecord = (decl: DataDecl): readonly IrField[] => {
    const done = out.get(decl.name);
    if (done !== undefined) return done;

    let inherited: readonly IrField[] = [];
    if (decl.base !== undefined) {
      const local = declared.get(decl.base.name);
      inherited =
        local !== undefined ? lowerRecord(local) : (inheritedFields?.get(decl.base.name) ?? []);
    }

    const fields = lowering.data(decl, inherited).fields;
    out.set(decl.name, fields);
    return fields;
  };

  for (const decl of declared.values()) lowerRecord(decl);
  return out;
}

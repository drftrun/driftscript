/**
 * What a module's components and entities are, and what a query term stands for.
 *
 * **Kept out of `checker.ts` because that file is eight times the guideline already**, and because
 * this is one question with one answer: given the declarations in a module, which components exist,
 * what fields does each have, and which components does a name in a query stand for. The checker
 * calls in and holds no entity knowledge of its own.
 *
 * ---
 *
 * ## A component's type is a record type
 *
 * `e.Health` produces the same shape a `data Health` would, so `.current` after it goes through the
 * field lookup the checker already has. **What that costs** is that a component and a record of the
 * same name would be indistinguishable to `assignable`, which is why declaring both is refused.
 * **What would make it wrong** is a component gaining something a record cannot have — a per-field
 * write permission, say — at which point a component needs a kind of its own and every reader of
 * `Type` grows a case.
 *
 * ## An entity is two things and the split is deliberate
 *
 * Its `require` list is a named component set, expanded wherever the name is used as a query term.
 * Its `var` fields become an implicit component named for the entity, so `a.Animal.target` reads a
 * field the entity itself declared. An entity with no `var` fields declares no component.
 */
import type {
  ComponentDecl,
  EntityDecl,
  Expr,
  FnDecl,
  Module,
  Span,
  Stmt,
  SystemDecl,
  TypeRef,
} from '../ast.ts';
import type { Diagnostic, DiagnosticCode } from '../diagnostics.ts';
import type { Type } from './types.ts';
import { checkEditorAnnotation } from './editor.ts';

export interface ComponentInfo {
  readonly name: string;
  /** `component X from host { … }` — asserted at bind rather than declared here. */
  readonly fromHost: boolean;
  /** A `data`-shaped type carrying the fields, so field access reuses the checker's lookup. */
  readonly type: Type;
  readonly span: Span;
  /** Set when this component is an entity's own `var` fields rather than a `component` declaration. */
  readonly fromEntity?: string;
}

export interface EntityInfo {
  readonly name: string;
  readonly requires: readonly { readonly name: string; readonly span: Span }[];
  /** The implicit component its `var` fields became, or undefined when it declared none. */
  readonly ownComponent: string | undefined;
  readonly span: Span;
}

export interface EntityModel {
  readonly components: ReadonlyMap<string, ComponentInfo>;
  readonly entities: ReadonlyMap<string, EntityInfo>;
}

/** What the checker lends this module: how to resolve a written type, and where to put a refusal. */
export interface CollectContext {
  resolveTypeRef(ref: ComponentDecl['fields'][number]['type']): Type;
  report(code: DiagnosticCode, message: string, span: Span): void;
  /** Names already taken by a record or an enum in this module. */
  taken(name: string): boolean;
}

function fieldsOf(
  decl: ComponentDecl | EntityDecl,
  name: string,
  context: CollectContext,
): Map<string, Type> {
  const fields = new Map<string, Type>();
  for (const field of decl.fields) {
    if (fields.has(field.name)) {
      context.report(
        'DS0287',
        `\`${name}\` declares the field \`${field.name}\` more than once`,
        field.span,
      );
      continue;
    }
    const type = context.resolveTypeRef(field.type);
    fields.set(field.name, type);
    /* Checked where the field's type is resolved, because that is the only place both halves of
       the question are in hand at once — the annotation and what it annotates. */
    checkEditorAnnotation(field, type, (code, message, span) => context.report(code, message, span));
  }
  return fields;
}

/**
 * Every component and entity a module declares.
 *
 * A name declared twice is refused once, at the second declaration, naming the first — and a
 * component sharing a name with a record or an enum is refused for the reason in the header: their
 * types would be indistinguishable, so `assignable` would accept one where the other was wanted.
 */
export function collectEntityModel(module: Module, context: CollectContext): EntityModel {
  const components = new Map<string, ComponentInfo>();
  const entities = new Map<string, EntityInfo>();

  const claim = (name: string, span: Span, what: string): boolean => {
    if (components.has(name) || entities.has(name)) {
      context.report('DS0287', `\`${name}\` is declared more than once in this module`, span);
      return false;
    }
    if (context.taken(name)) {
      context.report(
        'DS0287',
        `\`${name}\` is already a record or an enum in this module. A ${what} and a record of one ` +
          'name would have the same type, so a value of either would be accepted where the other ' +
          'was wanted.',
        span,
      );
      return false;
    }
    return true;
  };

  for (const decl of module.decls) {
    if (decl.kind !== 'component') continue;
    if (!claim(decl.name, decl.span, 'component')) continue;
    components.set(decl.name, {
      name: decl.name,
      fromHost: decl.fromHost,
      type: { kind: 'data', name: decl.name, fields: fieldsOf(decl, decl.name, context) },
      span: decl.span,
    });
  }

  for (const decl of module.decls) {
    if (decl.kind !== 'entity') continue;
    if (!claim(decl.name, decl.span, 'entity')) continue;

    /*
     * The implicit component takes the entity's own name, which is what makes `a.Animal.target`
     * read as the field the entity declared. An entity with no `var` fields declares none at all
     * rather than an empty one: an empty component is a marker, and a query over it would narrow to
     * entities that happen to carry a component nobody meant to create.
     */
    const ownComponent = decl.fields.length === 0 ? undefined : decl.name;
    if (ownComponent !== undefined) {
      components.set(decl.name, {
        name: decl.name,
        fromHost: false,
        type: { kind: 'data', name: decl.name, fields: fieldsOf(decl, decl.name, context) },
        span: decl.span,
        fromEntity: decl.name,
      });
    }
    entities.set(decl.name, {
      name: decl.name,
      requires: decl.requires,
      ownComponent,
      span: decl.span,
    });
  }

  return { components, entities };
}

/**
 * The components a query term stands for, in order, or `null` when the name is neither.
 *
 * A component stands for itself. An entity stands for everything it requires **and its own implicit
 * component**, which is the part that is easy to leave out: `query<Animal, Hunger>()` over an
 * `Animal` with `var` fields is four stores, not three, and a body reading `a.Animal.target` would
 * otherwise be reading a component the loop never required.
 *
 * A requirement naming something unknown is left to the caller to report, because only the caller
 * knows which span to point at — the query term or the entity's own `require` line.
 */
export function expandQueryTerm(name: string, model: EntityModel): readonly string[] | null {
  const entity = model.entities.get(name);
  if (entity !== undefined) {
    const expanded = entity.requires.map((required) => required.name);
    if (entity.ownComponent !== undefined) expanded.push(entity.ownComponent);
    return expanded;
  }
  return model.components.has(name) ? [name] : null;
}

/**
 * Every component a loop's terms require, flattened and deduplicated, in first-seen order.
 *
 * Order is kept rather than sorted because it decides which stores a generated `open` call takes
 * and which spill into `with` — and a set that reordered per compile would make the same source
 * emit different code on different runs.
 */
export function requiredComponents(
  terms: readonly string[],
  model: EntityModel,
): { readonly names: readonly string[]; readonly unknown: readonly string[] } {
  const names: string[] = [];
  const unknown: string[] = [];
  for (const term of terms) {
    const expanded = expandQueryTerm(term, model);
    if (expanded === null) {
      unknown.push(term);
      continue;
    }
    for (const name of expanded) if (!names.includes(name)) names.push(name);
  }
  return { names, unknown };
}

/** A diagnostic list, for a caller that collects rather than reports as it goes. */
export type EntityDiagnostics = readonly Diagnostic[];


/**
 * What one function or system touches: the components it reads and the ones it writes.
 *
 * **`writes` implies `reads`, and the implication is applied here rather than left to the engine.**
 * `BoundSystem`'s constructor adds every written type to its readable set, and its header says why:
 * a system that may write a component and not read it can only overwrite it. Emitting two
 * independent sets would mean a body that writes one component reported a `reads` the engine was
 * going to add anyway, and the two descriptions would read as disagreeing.
 */
/**
 * What a generated query loop needs, resolved: which stores to open, and which views to take.
 *
 * **An `entity` term is expanded here and never reaches a backend**, so nothing after the checker
 * has to know what an entity stands for. `views` carries one entry per component the body actually
 * touches, with whether that touch includes a write — which decides whether the generated code asks
 * the host for a writable view, and therefore which of the engine's two declaration checks it faces.
 */
export interface QueryPlan {
  /**
   * The identifier the generated code passes as the world.
   *
   * A system's own view, or the name of the `World` parameter the enclosing function declared. The
   * checker resolves it because the checker is what knows the scope; a backend receives a name and
   * asks no questions about where it came from.
   */
  readonly world: string;
  /** Components an entity must have to be yielded, in first-seen order. */
  readonly required: readonly string[];
  /** Components an entity must not have. */
  readonly excluded: readonly string[];
  /** One per component the body touches: the view to take, and whether it must be writable. */
  readonly views: readonly { readonly component: string; readonly forWriting: boolean }[];
}

export interface Access {
  readonly reads: ReadonlySet<string>;
  readonly writes: ReadonlySet<string>;
}

/**
 * Which component a `<handle>.<Component>` expression names, or null.
 *
 * Purely syntactic: it matches the *shape* rather than consulting a type. That is sound because the
 * checker has already refused `x.Component` on anything that is not a handle, and it is what lets
 * this run over the tree without threading the type map through.
 */
function componentNamed(expr: Expr, model: EntityModel): string | null {
  if (expr.kind !== 'member') return null;
  return model.components.has(expr.name) ? expr.name : null;
}

/**
 * The component an assignment target writes, if any.
 *
 * `e.Hunger.value = 1` is `member(member(ident, 'Hunger'), 'value')`, so the component is one level
 * in from the target. `e.Hunger = …` never type-checks — a component is not a value a script can
 * hold — so the one-level walk is the whole of it.
 */
function writtenComponent(
  target: Expr,
  model: EntityModel,
  rows: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (target.kind !== 'member' && target.kind !== 'optionalMember') return null;
  /* `m.x = 1` on a component parameter is one member deep, where `e.Hunger.value = 1` is two. */
  if (target.target.kind === 'ident') {
    const row = rows.get(target.target.name);
    if (row !== undefined) return row;
  }
  return componentNamed(target.target, model);
}

/**
 * Everything a body touches directly, and every function it calls by name.
 *
 * `rows` names the body's component parameters. A helper written `fn advance(m: mut Placement, …)` touches
 * `Placement` through `m.x`, which is **one** member deep where every other component access is two — so
 * without this the access is invisible, the caller's view comes back read-only, and a declaration
 * that named the component reads as over-wide.
 */
function directAccess(
  body: readonly Stmt[],
  model: EntityModel,
  rows: ReadonlyMap<string, string> = new Map(),
): { reads: Set<string>; writes: Set<string>; calls: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const calls = new Set<string>();

  /** The component `m.x` reads, when `m` is a component parameter. */
  const rowRead = (expr: Expr): string | null => {
    if (expr.kind !== 'member' && expr.kind !== 'optionalMember') return null;
    if (expr.target.kind !== 'ident') return null;
    return rows.get(expr.target.name) ?? null;
  };

  const fromExpr = (expr: Expr): void => {
    const named = componentNamed(expr, model);
    if (named !== null) reads.add(named);
    const row = rowRead(expr);
    if (row !== null) reads.add(row);
    switch (expr.kind) {
      case 'call':
        if (expr.callee.kind === 'ident') calls.add(expr.callee.name);
        expr.args.forEach(fromExpr);
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
      case 'compoundAssign': {
        const written = writtenComponent(stmt.target, model, rows);
        if (written !== null) writes.add(written);
        /*
         * **A plain assignment's target is written, not read, and the implication supplies the
         * read.** Walking it as a read as well was a second defence for one case: `writes` implies
         * `reads` at the end of `inferAccess`, so a component only ever assigned to landed in both
         * sets either way — and with both in place, removing either changed nothing and neither was
         * tested. A compound assignment genuinely reads its target, so that one is still walked.
         */
        if (stmt.kind === 'compoundAssign' || written === null) fromExpr(stmt.target);
        fromExpr(stmt.value);
        return;
      }
      case 'return':
        if (stmt.value !== undefined && stmt.value !== null) fromExpr(stmt.value);
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
      case 'forQuery': {
        /*
         * **A component a query narrows by is read, and this walk skipped the terms until
         * 2026-08-28.**
         *
         * It walked a loop's *body* and never its own `query<…>`, so a component that appears in a
         * query and nowhere else was invisible here — and a host's runtime does not agree. The
         * engine that reported this refuses `query` unless every component in it is declared,
         * because a schedule derived from declarations is wrong the moment a system touches more
         * than it says. So the declaration the host demanded was one `DS0291` called unused, and
         * following that advice produced a module that compiled clean, passed every check the
         * reporter had, and threw once per tick from inside the schedule — taking every system
         * after it down with it, and presenting as a *different* system stuttering.
         *
         * Two diagnostics changed direction with this. `DS0291` stops calling a query's own
         * declaration unused, and `DS0288` starts refusing the omission at compile time, which is
         * where the reporter had wanted it.
         *
         * **A `without` term is not counted, and that is the host's rule rather than a
         * convenience.** An exclusion never looks inside the component, and an entity a `without`
         * matched is not in the result at all — which is why `checker.ts` also keeps those out of
         * the loop's readable set and why the generated code passes them to a separate host call.
         * `with` *is* counted: it reaches the same `query` call the required terms do.
         */
        const named = (ref: TypeRef): string => (ref.kind === 'option' ? '' : ref.name);
        const excluded = new Set(
          requiredComponents(stmt.query.without.map(named), model).names,
        );
        const narrowing = requiredComponents(
          [...stmt.query.required, ...stmt.query.with].map(named),
          model,
        ).names;
        /* An unknown term is dropped rather than guessed at: `checker.ts` reports it as DS0286,
           and this analysis has no span to point at. */
        for (const component of narrowing) if (!excluded.has(component)) reads.add(component);
        stmt.body.forEach(fromStmt);
        return;
      }
      case 'scope':
        stmt.body.forEach(fromStmt);
        return;
      case 'emit':
        for (const field of stmt.fields) fromExpr(field.value);
        return;
      case 'spawn':
      case 'awaitTask':
        stmt.args.forEach(fromExpr);
        return;
      case 'await':
        fromExpr(stmt.duration);
        return;
      case 'become':
        return;
      case 'forList':
        fromExpr(stmt.subject);
        stmt.body.forEach(fromStmt);
        return;
      case 'loopJump':
        /* No expression, so leaving a loop reads and writes no component. */
        return;
      default:
        /* Exhaustive for the same reason `check/effects.ts` is: a statement kind this walk skips
           is a statement whose component access is invisible, and an undeclared write then reaches
           the engine as a runtime refusal instead of a diagnostic. */
        assertWalked(stmt);
        return;
    }
  };

  body.forEach(fromStmt);
  return { reads, writes, calls };
}

function assertWalked(stmt: never): void {
  throw new Error(
    `component-access inference does not walk \`${(stmt as { kind: string }).kind}\`, so every ` +
      'access inside one is invisible to it. Add a case above.',
  );
}

/**
 * What every function and system in a module touches, propagated through calls to a fixed point.
 *
 * The same shape `check/effects.ts` uses for effects, and for the same reason: component access is
 * a property of the code, and a function that calls something which writes `Hunger` writes `Hunger`
 * whether or not anybody wrote it down. Iteration is bounded because each round can only add.
 */
export function inferAccess(
  module: Module,
  model: EntityModel,
): ReadonlyMap<string, Access> {
  const fns = module.decls.filter((d): d is FnDecl => d.kind === 'fn');
  const systems = module.decls.filter((d): d is SystemDecl => d.kind === 'system');

  const reads = new Map<string, Set<string>>();
  const writes = new Map<string, Set<string>>();
  const calls = new Map<string, ReadonlySet<string>>();

  for (const decl of [...fns, ...systems]) {
    /* A system takes no parameters, so its row map is always empty; a function's comes from the
       parameters whose written type names a component. */
    const rows = new Map<string, string>();
    if (decl.kind === 'fn') {
      for (const param of decl.params) {
        if (param.type.kind === 'named' && param.type.args.length === 0 && model.components.has(param.type.name)) {
          rows.set(param.name, param.type.name);
        }
      }
    }
    const found = directAccess(decl.body, model, rows);
    reads.set(decl.name, found.reads);
    writes.set(decl.name, found.writes);
    calls.set(decl.name, found.calls);
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, callees] of calls) {
      for (const callee of callees) {
        const calleeReads = reads.get(callee);
        const calleeWrites = writes.get(callee);
        if (calleeReads === undefined || calleeWrites === undefined) continue;
        const mineReads = reads.get(name) as Set<string>;
        const mineWrites = writes.get(name) as Set<string>;
        for (const component of calleeReads) {
          if (!mineReads.has(component)) {
            mineReads.add(component);
            grew = true;
          }
        }
        for (const component of calleeWrites) {
          if (!mineWrites.has(component)) {
            mineWrites.add(component);
            grew = true;
          }
        }
      }
    }
  }

  const access = new Map<string, Access>();
  for (const [name, mineReads] of reads) {
    const mineWrites = writes.get(name) as Set<string>;
    /* `writes` implies `reads`, applied once and here — see `Access`. */
    for (const component of mineWrites) mineReads.add(component);
    access.set(name, { reads: mineReads, writes: mineWrites });
  }
  return access;
}


/**
 * What one block touches: its own accesses, plus everything the functions it calls touch.
 *
 * **A loop's views need this at block granularity**, not per function. Whether a generated loop
 * takes a *writable* view of a component is decided by whether that loop's body writes it — and a
 * body that writes through a helper writes it just as much as one that writes it inline, which is
 * why the propagated map is passed in rather than recomputed direct-only here.
 */
export function accessOfBody(
  body: readonly Stmt[],
  model: EntityModel,
  propagated: ReadonlyMap<string, Access>,
): Access {
  const found = directAccess(body, model);
  for (const callee of found.calls) {
    const theirs = propagated.get(callee);
    if (theirs === undefined) continue;
    for (const component of theirs.reads) found.reads.add(component);
    for (const component of theirs.writes) found.writes.add(component);
  }
  for (const component of found.writes) found.reads.add(component);
  return { reads: found.reads, writes: found.writes };
}

/**
 * Check a system's `reads` and `writes` against what its body actually does.
 *
 * **The declaration is an assertion, not the source of truth**, which is the call `check/effects.ts`
 * already made for the same kind of fact: effects are inferred and `@pure` is verified. A mandatory
 * declaration would be a second philosophy for one kind of fact, and one the compiler could have
 * written itself.
 *
 * Two directions and they are not symmetric:
 *
 *   - **A write the body makes and the declaration omits is an error.** This is the diagnostic the
 *     whole first-class treatment is argued for: the engine refuses the same write at runtime, and
 *     catching it here is the difference between a squiggle and a crash three frames in.
 *   - **A declaration wider than the body is a warning.** Widening costs grouping in the schedule
 *     and is sometimes what an author means — a system about to gain a write, held stable so the
 *     order does not move under a series of edits. An error would make that unsayable.
 *
 * A declared name that is not a component at all is an error in either direction, because a
 * constraint naming nothing silently does nothing.
 */
export function checkSystemDeclarations(
  system: SystemDecl,
  inferred: Access,
  model: EntityModel,
  report: (code: DiagnosticCode, severity: 'error' | 'warning', message: string, span: Span) => void,
): void {
  /*
   * **A system that declares neither clause asserts nothing, so there is nothing to violate.**
   *
   * That is what makes `reads` and `writes` genuinely optional rather than optional-until-you-touch
   * anything: the inferred sets ride in the module metadata and the host builds the schedule from
   * them, so a system with no clauses is fully described without an author writing a word. Checking
   * it anyway would report every access as undeclared and make the quiet form unusable.
   */
  if (system.reads.length === 0 && system.writes.length === 0) return;

  const declaredReads = new Set<string>();
  const declaredWrites = new Set<string>();

  for (const [clause, into] of [
    [system.reads, declaredReads],
    [system.writes, declaredWrites],
  ] as const) {
    for (const named of clause) {
      if (!model.components.has(named.name)) {
        report(
          'DS0286',
          'error',
          `\`${named.name}\` is not a component in this module, so declaring it constrains nothing`,
          named.span,
        );
        continue;
      }
      into.add(named.name);
    }
  }

  /* A declared write is a declared read, matching what the engine does with the same pair. */
  for (const written of declaredWrites) declaredReads.add(written);

  for (const written of inferred.writes) {
    if (declaredWrites.has(written)) continue;
    report(
      'DS0288',
      'error',
      `\`${system.name}\` writes \`${written}\` and does not declare it. Add \`writes ${written}\`, ` +
        'or the engine refuses the write when the system runs.',
      system.span,
    );
  }

  for (const read of inferred.reads) {
    if (declaredReads.has(read)) continue;
    report(
      'DS0288',
      'error',
      `\`${system.name}\` reads \`${read}\` and does not declare it. Add \`reads ${read}\`, or the ` +
        'engine refuses the read when the system runs.',
      system.span,
    );
  }

  for (const declared of declaredWrites) {
    if (inferred.writes.has(declared)) continue;
    report(
      'DS0291',
      'warning',
      `\`${system.name}\` declares \`writes ${declared}\` and never writes it. A wider declaration ` +
        'costs grouping in the schedule; keep it if the write is coming, remove it otherwise.',
      system.span,
    );
  }
  for (const declared of declaredReads) {
    if (inferred.reads.has(declared) || declaredWrites.has(declared)) continue;
    report(
      'DS0291',
      'warning',
      `\`${system.name}\` declares \`reads ${declared}\` and never reads it. A wider declaration ` +
        'costs grouping in the schedule; keep it if the read is coming, remove it otherwise.',
      system.span,
    );
  }
}

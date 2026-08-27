/**
 * Resolving names and types, and reporting everything it can rather than the first thing it can.
 *
 * Two passes. The first collects every `data` and `enum` declaration and every function signature,
 * so a function may refer to anything declared below it — a language that required declaration
 * order would make two mutually-referring records unwritable. The second walks each body.
 *
 * **An unresolved name yields `ERROR` and the walk continues.** That is what stops one bad type
 * annotation producing a diagnostic at every use, which is the difference between a compiler that
 * tells you what is wrong and one that tells you what went wrong afterwards.
 *
 * Nothing throws, for the reason `diagnostics.ts` gives.
 */
import type {
  DataDecl,
  EnumDecl,
  EventDecl,
  Expr,
  FnDecl,
  Module,
  OnDecl,
  Pattern,
  Span,
  StateDecl,
  Stmt,
  TaskDecl,
  TypeRef,
  SystemDecl,
  PrefabDecl,
  ConstDecl,
} from '../ast.ts';
import type { Diagnostic, DiagnosticCode } from '../diagnostics.ts';
import { FLOAT, type CapabilityRegistry } from '../../registry/capability.ts';
import { isPrimitive } from '../tokens.ts';
import {
  BOOL,
  ERROR,
  FLOATS,
  INTEGERS,
  STRING,
  type Type,
  VOID,
  assignable,
  isBool,
  isFloat,
  isNumeric,
  nameOf,
  option,
  primitive,
  primitiveType,
  result,
  same,
} from './types.ts';
import {
  type Access,
  type EntityModel,
  type QueryPlan,
  accessOfBody,
  checkSystemDeclarations,
  collectEntityModel,
  inferAccess,
  requiredComponents,
} from './entities.ts';

export interface FnSignature {
  readonly params: readonly { readonly name: string; readonly type: Type }[];
  readonly returns: Type;
}

/**
 * Declarations another module published, already resolved in *its* scope.
 *
 * **Kept beside the local maps rather than merged into them**, for two reasons that both show up as
 * wrong diagnostics if merged. A local declaration would collide with an imported one and report
 * "declared more than once in this module" about a name declared once, in another file. And a local
 * declaration could not shadow an import, which it should: the file you are reading wins over the
 * file you are importing.
 *
 * The types are resolved rather than syntactic because an imported record's fields may name types
 * from *its* module that this one never imported. Resolving them here would need that module's scope,
 * which is exactly what the module that owns them already has.
 */
export interface ImportedScope {
  readonly data: ReadonlyMap<string, Type>;
  readonly enums: ReadonlyMap<string, Type>;
  readonly functions: ReadonlyMap<string, FnSignature>;
  /** Module constants, which cross a file boundary as an ordinary import like a function does. */
  readonly constants: ReadonlyMap<string, Type>;
}

export interface CheckResult {
  /** The resolved type of every expression the checker visited. Lowering reads this. */
  readonly types: ReadonlyMap<Expr, Type>;
  /** Every declared record, by name. */
  readonly data: ReadonlyMap<string, Type>;
  /** Every declared enum, by name. */
  readonly enums: ReadonlyMap<string, Type>;
  readonly functions: ReadonlyMap<string, FnSignature>;
  /** Every module constant this file declares, by name. Lowering emits one `const` for each. */
  readonly constants: ReadonlyMap<string, Type>;
  /**
   * Each query loop's resolved plan, keyed by its statement.
   *
   * Lowering reads this rather than re-deriving it: only the checker knows what an `entity` term
   * expands to and which components a body writes, and a second place deciding either would be a
   * second answer to one question.
   */
  readonly queries: ReadonlyMap<Stmt, QueryPlan>;
  /** What every function and system touches, for the metadata a host builds a schedule from. */
  readonly access: ReadonlyMap<string, Access>;
  /**
   * Capability calls whose result the backend must round to `f32`.
   *
   * A `float` capability is implemented once, in double, and the *call site* rounds — which is
   * where this language already says rounding belongs, since `a * b` on `f32` emits its own
   * `Math.fround` rather than trusting an operand to have been rounded. Only the checker knows
   * which width a call resolved to, so it records the set and lowering reads it, exactly as it does
   * for `queries`. A second place deciding this would be a second answer to one question.
   *
   * Emptied of everything else on purpose: an ordinary `f32`-returning capability is *not* in here.
   * The host computed it at the width it declared, and wrapping every such call would put a
   * function call on a per-frame path to re-round a number that was already rounded.
   */
  readonly rounded: ReadonlySet<Expr>;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The name a system's world is bound under, in its body and in its generated function.
 *
 * One constant read by the checker and the emitter, because the checker records it into every plan
 * and the emitter writes the parameter — two spellings would be a generated function whose body
 * referred to an argument it did not have.
 *
 * **`world` rather than a `$`-prefixed name, because a system body has to be able to say it.** A
 * query finds the world without naming it, but `ecs.destroy(world, e)` cannot — every `drift/ecs`
 * capability takes the world as an argument, and a system that could query but not destroy would be
 * a system that had to hand its work to a helper for the most ordinary thing it does.
 *
 * This is a **binding in scope** rather than a hidden parameter, which is the distinction the
 * refusal in `forQuery` turns on: a system takes no arguments from anybody, so there is no caller
 * being burdened with something they cannot see. **What it costs** is that `let world = …` inside a
 * system shadows it, which is ordinary scoping and visible in the file.
 */
export const SYSTEM_VIEW = 'world';

/**
 * Whether an expression is a constant a prefab can hold.
 *
 * Literals and unary arithmetic over them. Deliberately not a folding evaluator: a prefab's value
 * is what an editor shows and what a save file holds, and a number arrived at by arithmetic is a
 * number somebody has to run the compiler to see. What would make that wrong is a corpus file that
 * cannot say what it means without one.
 */
function isConstantExpr(expr: Expr): boolean {
  if (expr.kind === 'number' || expr.kind === 'string' || expr.kind === 'bool') return true;
  return expr.kind === 'unary' && isConstantExpr(expr.operand);
}

/**
 * Whether a numeric expression would take its width from an expectation rather than carry one.
 *
 * A bare literal and a negated one, and nothing else. This is the same rule `checkExpr` already
 * applies to a `number` — it has no width until something gives it one — read from the outside so
 * a `float` capability call can decide which of its arguments get to fix the call's width. An
 * expression with any other shape has a type of its own and is therefore evidence.
 *
 * Deliberately *not* a fold: `math.min(x, 1 + 1)` leaves the sum to fix its own width and report
 * its own mismatch, which is where a reader would look for it.
 */
function takesWidthFromContext(expr: Expr): boolean {
  if (expr.kind === 'number') return true;
  return expr.kind === 'unary' && expr.op === '-' && takesWidthFromContext(expr.operand);
}

/** Every identifier a constant's value names, which is what decides the order they are typed in. */
function constantReferences(expr: Expr): Set<string> {
  const names = new Set<string>();
  const walk = (node: Expr): void => {
    switch (node.kind) {
      case 'ident':
        names.add(node.name);
        return;
      case 'unary':
        walk(node.operand);
        return;
      case 'binary':
        walk(node.left);
        walk(node.right);
        return;
      default:
        /* Every other form is refused by `refuseNonConstant`, so there is nothing under it that
           could name a constant. */
        return;
    }
  };
  walk(expr);
  return names;
}

/** A name bound in a body, and whether it may be written through. */
interface Binding {
  readonly type: Type;
  readonly mutable: boolean;
}

/**
 * A lexical scope, chained to its parent.
 *
 * A flat map per function would let a name declared inside an `if` outlive the block it was written
 * in, which is the shape that makes shadowing read as reassignment. The chain is three lines and
 * removes the question.
 */
class Scope {
  private readonly names = new Map<string, Binding>();
  private readonly parent: Scope | null;

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  declare(name: string, binding: Binding): void {
    this.names.set(name, binding);
  }

  lookup(name: string): Binding | undefined {
    return this.names.get(name) ?? this.parent?.lookup(name);
  }

  child(): Scope {
    return new Scope(this);
  }
}

/** The built-in constructors, which are functions in every way except that nobody declared them. */
const BUILTIN_CONSTRUCTORS: ReadonlySet<string> = new Set(['Ok', 'Err', 'some', 'none']);

class Checker {
  private readonly types = new Map<Expr, Type>();
  private readonly data = new Map<string, Type>();
  /** Base clauses as written, resolved after every record is collected. See `resolveBases`. */
  private readonly declaredBases = new Map<string, { name: string; span: Span }>();
  private readonly enums = new Map<string, Type>();
  private readonly functions = new Map<string, FnSignature>();
  /** Tasks, which share the function namespace and are not callable. See `collectTask`. */
  private readonly tasks = new Map<string, FnSignature>();
  /**
   * Events, kept out of `data` so that a name meant for `emit` cannot be constructed as a record.
   *
   * The value is a `data` type all the same, because that is what the payload *is* once it exists —
   * so field access on an `on` binding goes through the ordinary member rules with nothing added.
   */
  private readonly events = new Map<string, Type>();
  /** Which of an event's fields carry a default, so an `emit` may omit exactly those. */
  private readonly eventDefaults = new Map<string, Set<string>>();
  /** Declared states, in declaration order — the first is where the machine starts. */
  private readonly states = new Map<string, StateDecl>();
  /** Whether the statement being checked is inside a `state`, which is what `become` needs. */
  /**
   * The module's components and entities, collected before any body is checked.
   *
   * Collected rather than resolved on demand, because a query may name a component declared further
   * down the file — the same rule every other declaration in this language follows.
   */
  private entityModel: EntityModel = { components: new Map(), entities: new Map() };
  /**
   * What each query binding in scope may reach, keyed by the binding's name.
   *
   * **Per binding rather than per loop, and that distinction is the whole of it.** A nested loop
   * does not stop the outer loop's entity from having the components it was selected for — `a` is
   * still an `Animal` inside a loop over `Health`. A single "innermost requirements" field made
   * every outer binding unreachable in a nested body, which is a refusal of correct code.
   */
  private readonly queryRequirements = new Map<string, ReadonlySet<string>>();
  /**
   * What every function and system touches, inferred once before any body is checked.
   *
   * Before rather than after, because a query loop's *plan* needs it: whether a generated loop
   * takes a writable view of a component depends on whether that loop's body writes it, and a body
   * that writes through a helper needs the propagated answer.
   */
  private access: ReadonlyMap<string, Access> = new Map();
  /**
   * Each query loop's resolved plan, keyed by the statement.
   *
   * Recorded here rather than recomputed while lowering, for the reason the type map exists: the
   * checker is the only thing that knows what an `entity` term expands to, and a second place that
   * decided it would be a second answer.
   */
  private readonly queries = new Map<Stmt, QueryPlan>();

  /** Capability calls that resolved a `float` signature at `f32`. See `CheckResult.rounded`. */
  private readonly rounded = new Set<Expr>();

  /** This file's module constants, by name, once their values have been typed. */
  private readonly constants = new Map<string, Type>();

  /**
   * The world a query loop in this body would run against, or null when there is none.
   *
   * **A query needs a world, and a world is a thing in scope rather than a thing a form implies.**
   * A system has one — the view the schedule hands it, which its generated function takes as a
   * parameter. A function or a task has one when it declares a `World` parameter. Nothing else does,
   * and inventing an implicit argument for the rest would be a hidden parameter every caller had to
   * supply without writing it.
   *
   * Holding the *name* rather than a flag is what lets a plan record which world to pass, so a
   * backend receives an identifier and asks nothing about where it came from.
   */
  private worldInScope: string | null = null;
  private inState = false;
  /** Whether the statement being checked is inside a task, which is what `await` and `scope` need. */
  private inTask = false;

  /**
   * How many loops enclose the statement being checked, which is what `break` and `continue` need.
   *
   * A counter rather than a stack of loop kinds, because the language has no labels: a jump always
   * means the innermost loop, so the only question is whether there is one. **What would make a
   * stack necessary** is a labelled jump, which nothing has asked for.
   *
   * It is saved and restored around a body rather than incremented globally, because a `fn` called
   * from inside a loop is not itself inside one — a jump in its body would have nowhere to go, and
   * a counter that leaked across the call would have accepted it.
   */
  private loopDepth = 0;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly file: string;
  private readonly registry: CapabilityRegistry | undefined;
  /**
   * The module each namespace refers to, and which of its members this file imported.
   *
   * **An import binds the module's last path segment as a namespace.** `import { play } from
   * "drift/audio"` makes `audio.play(…)` available, and the named list says which members this file
   * uses. The two are not redundant: the namespace at a call site says which module a call reaches,
   * which is what a reader of a behaviour script wants; the list at the top says what the file
   * depends on, which is what a reviewer and the linker want.
   *
   * Calling a member the file did not import is an error, so the list is meaningful rather than
   * decorative.
   */
  private readonly namespaces = new Map<string, { module: string; names: ReadonlySet<string> }>();
  /** Capability members actually called, so an import nobody uses can be reported. */
  private readonly usedCapabilities = new Set<string>();
  /** Where each import named each member, so the warning lands on the name rather than the line. */
  private readonly importSpans = new Map<string, Span>();
  /** The return type of the function currently being checked, for `return` and `?`. */
  private returns: Type = VOID;

  private readonly imported: ImportedScope | undefined;

  constructor(file: string, registry?: CapabilityRegistry, imported?: ImportedScope) {
    this.file = file;
    this.registry = registry;
    this.imported = imported;
  }

  /* Local first, then imported. A declaration in the file being read shadows one it imports, which
     is the direction a reader expects: the names in front of you win. */
  private lookupData(name: string): Type | undefined {
    return this.data.get(name) ?? this.imported?.data.get(name);
  }

  private lookupEnum(name: string): Type | undefined {
    return this.enums.get(name) ?? this.imported?.enums.get(name);
  }

  private lookupFn(name: string): FnSignature | undefined {
    return this.functions.get(name) ?? this.imported?.functions.get(name);
  }

  /** A module constant, this file's or an imported one's. Merged the way `lookupFn` merges. */
  private lookupConst(name: string): Type | undefined {
    return this.constants.get(name) ?? this.imported?.constants.get(name);
  }

  /**
   * Type every module constant, in whatever order their references require.
   *
   * **Resolved by repetition rather than by a topological sort**, and the repetition is what
   * detects a cycle. Each round types every constant whose references are already known; a round
   * that resolves nothing means the ones left refer only to each other, and they are reported
   * together. A sort would need its own cycle detection, which is this loop again with more code.
   *
   * **Declaration order carries no meaning here**, exactly as it carries none for a function.
   * `LANGUAGE.md` promises that in one sentence with no exceptions, and a constant that had to be
   * written above its user would have been the exception a reader keeps a list for. The emitter
   * pays for it by writing them out in dependency order.
   *
   * A value is checked against a scope with no locals in it, because there are none: a module
   * constant is evaluated where nothing is in scope but other constants.
   */
  private collectConstants(module: Module): void {
    const pending = module.decls.filter((d): d is ConstDecl => d.kind === 'const');
    const declared = new Set(pending.map((d) => d.name));

    for (const decl of pending) {
      if (this.constants.has(decl.name)) {
        this.report('DS0242', `\`${decl.name}\` is declared twice in this module`, decl.span);
        continue;
      }
      if (this.functions.has(decl.name) || this.lookupFn(decl.name) !== undefined) {
        this.report(
          'DS0242',
          `\`${decl.name}\` is both a constant and a function; one name is one thing`,
          decl.span,
        );
        continue;
      }
      this.constants.set(decl.name, ERROR);
    }

    /* `ERROR` above is a placeholder so that a name is *known* while the values are typed — it is
       what stops a reference to a constant declared later reading as "not defined". Each is
       replaced below by the type its value turned out to have. */
    const unresolved = new Map(pending.map((d) => [d.name, d] as const));
    const resolved = new Set<string>();

    for (;;) {
      let progressed = false;
      for (const [name, decl] of unresolved) {
        const references = constantReferences(decl.value);
        /* A reference to something that is not a constant of this module is left to the value check
           below, which reports it properly. Only *pending* names hold this one back. */
        if ([...references].some((ref) => declared.has(ref) && !resolved.has(ref) && ref !== name)) {
          continue;
        }
        this.checkConstantValue(decl);
        resolved.add(name);
        unresolved.delete(name);
        progressed = true;
      }
      if (unresolved.size === 0) break;
      if (!progressed) {
        /* Every name in the cycle is reported, and each names the whole set, because a cycle read
           as one edge sends a reader to whichever file the edge happened to point at. The same call
           `resolveBases` makes for a record's base chain. */
        const names = [...unresolved.keys()].sort();
        for (const decl of unresolved.values()) {
          this.report(
            'DS0240',
            `\`${decl.name}\` is defined in terms of itself, through ${names
              .map((n) => `\`${n}\``)
              .join(', ')}`,
            decl.span,
          );
        }
        break;
      }
    }
  }

  /**
   * Type one constant's value and refuse anything that is not constant.
   *
   * **No calls, and that is the line.** A call could reach a capability, which would make a module's
   * load order observable and would put a host call on the path a module is evaluated on — before
   * `__bind` has run, so the namespace is not even there yet. Arithmetic over literals and other
   * constants is the whole of what is allowed, which is what a table of numbers needs.
   */
  private checkConstantValue(decl: ConstDecl): void {
    const declared = decl.type === undefined ? undefined : this.resolveTypeRef(decl.type);
    if (!this.refuseNonConstant(decl.value, decl.name)) {
      this.constants.set(decl.name, declared ?? ERROR);
      return;
    }

    const actual = this.checkExpr(decl.value, new Scope(), declared);
    if (declared !== undefined && !assignable(actual, declared)) {
      this.report(
        'DS0208',
        `\`${decl.name}\` is declared \`${nameOf(declared)}\` but its value is \`${nameOf(actual)}\``,
        decl.value.span,
      );
    }
    this.constants.set(decl.name, declared ?? actual);
  }

  /** Walk a constant's value, reporting the first form that could not be evaluated at load. */
  private refuseNonConstant(expr: Expr, name: string): boolean {
    switch (expr.kind) {
      case 'number':
      case 'string':
      case 'bool':
        return true;
      case 'unary':
        return this.refuseNonConstant(expr.operand, name);
      case 'binary':
        return (
          this.refuseNonConstant(expr.left, name) && this.refuseNonConstant(expr.right, name)
        );
      case 'ident':
        /* Another constant, or a name the expression check will report as undefined. Either way it
           is not a *form* this refuses. */
        return true;
      default:
        this.report(
          'DS0239',
          `\`${name}\` is a module constant, so its value has to be a number, a string, a \`bool\`, ` +
            'arithmetic over those, or another constant. A call cannot run here — a module is ' +
            'evaluated before its host is bound.',
          expr.span,
        );
        return false;
    }
  }

  private report(code: DiagnosticCode, message: string, span: Span): void {
    this.diagnostics.push({ code, severity: 'error', message, file: this.file, ...span });
  }

  private warn(code: DiagnosticCode, message: string, span: Span): void {
    this.diagnostics.push({ code, severity: 'warning', message, file: this.file, ...span });
  }

  private record(expr: Expr, type: Type): Type {
    this.types.set(expr, type);
    return type;
  }

  /**
   * The collection phases, without the checking ones.
   *
   * Deliberately the *same* two passes `check` runs — records and enums first, then signatures —
   * rather than a second traversal that would drift from it. What it omits is `checkFn` and the
   * unused-import warning, both of which are about a body or about this file's own hygiene and
   * neither of which another module can see.
   */
  collect(
    module: Module,
  ): ImportedScope & {
    readonly types: ReadonlyMap<Expr, Type>;
    readonly diagnostics: readonly Diagnostic[];
  } {
    for (const decl of module.decls) {
      if (decl.kind === 'data') this.collectData(decl);
      else if (decl.kind === 'enum') this.collectEnum(decl);
    }
    this.resolveBases();
    this.collectEntities(module);
    for (const decl of module.decls) {
      if (decl.kind === 'fn') this.collectFn(decl);
      else if (decl.kind === 'task') this.collectTask(decl);
      else if (decl.kind === 'event') this.collectEvent(decl);
      else if (decl.kind === 'state') this.collectState(decl);
    }
    /* After the signatures, so a name that is both a constant and a function is caught; before the
       defaults, because a record's default may name a constant. */
    this.collectConstants(module);
    /*
     * Record defaults are checked here; function bodies are not.
     *
     * A dependent needs another module's *defaults* — a subtype inlines its base's, and they come
     * from the base's own file — so the expressions have to be typed for lowering to reach them.
     * Bodies stay unchecked, which is the expensive half and the half nothing outside the module
     * can see.
     */
    for (const decl of module.decls) {
      if (decl.kind === 'data') this.checkDataDefaults(decl);
    }
    return {
      data: this.data,
      enums: this.enums,
      functions: this.functions,
      constants: this.constants,
      types: this.types,
      diagnostics: this.diagnostics,
    };
  }

  check(module: Module): CheckResult {
    for (const decl of module.imports) {
      /*
       * A file import binds no namespace and is not tracked for use.
       *
       * `usedCapabilities` records members reached through a namespace, which is the only thing the
       * unused warning can see — so a relative import left in this loop is reported unused the
       * moment it exists, however heavily the file uses it. That is what happened when file imports
       * landed: every one of them warned.
       *
       * The cost is that an unused *file* import is not reported at all. That needs usage tracking
       * over ordinary identifiers rather than over namespace members, and a warning that is
       * sometimes wrong is worse than one that is missing — which is the same argument the language
       * server makes about a squiggle.
       */
      if (decl.relative) continue;

      const segment = decl.module.split('/').pop() ?? decl.module;
      const existing = this.namespaces.get(segment);
      /* Two imports of the same module merge their name lists, so a file may group its imports by
         what they are for rather than by which module they came from. */
      const names = new Set(existing?.names ?? []);
      for (const name of decl.names) {
        names.add(name);
        if (!this.importSpans.has(`${decl.module}.${name}`)) {
          this.importSpans.set(`${decl.module}.${name}`, decl.span);
        }
      }
      this.namespaces.set(segment, { module: decl.module, names });
    }

    for (const decl of module.decls) {
      if (decl.kind === 'data') this.collectData(decl);
      else if (decl.kind === 'enum') this.collectEnum(decl);
    }
    /* Before signatures and before bodies: a parameter typed as a subtype has to see the fields it
       inherited, or every access to one is an error about a field that is there. */
    this.resolveBases();
    this.collectEntities(module);
    for (const decl of module.decls) {
      if (decl.kind === 'fn') this.collectFn(decl);
      else if (decl.kind === 'task') this.collectTask(decl);
      else if (decl.kind === 'event') this.collectEvent(decl);
      else if (decl.kind === 'state') this.collectState(decl);
    }
    this.collectConstants(module);
    for (const decl of module.decls) {
      if (decl.kind === 'data') this.checkDataDefaults(decl);
      else if (decl.kind === 'fn') this.checkFn(decl);
      else if (decl.kind === 'task') this.checkTask(decl);
      else if (decl.kind === 'event') this.checkEventDefaults(decl);
      else if (decl.kind === 'on') this.checkOn(decl);
      else if (decl.kind === 'state') this.checkState(decl);
      else if (decl.kind === 'system') this.checkSystem(decl);
      else if (decl.kind === 'prefab') this.checkPrefab(decl);
    }
    this.checkMachine();
    /* After the bodies, because inference reads the same tree and access from a body with a type
       error in it is not worth reporting a declaration against. */
    this.checkSystemAccess(module);
    this.reportUnusedImports();

    return {
      types: this.types,
      data: this.data,
      enums: this.enums,
      functions: this.functions,
      constants: this.constants,
      queries: this.queries,
      access: this.access,
      rounded: this.rounded,
      diagnostics: this.diagnostics,
    };
  }

  /**
   * An imported capability nobody calls, as a **warning**.
   *
   * The import list is what the linker reads and what a reviewer reads, so a name in it that
   * nothing uses makes a file claim a dependency it does not have — and a target manifest then
   * carries a module for the sake of one unused name.
   *
   * A warning rather than an error, because it never makes a program wrong: a half-written file
   * mid-edit has unused imports constantly, and an error would make the editor shout at somebody
   * for not having finished typing yet.
   *
   * **Only reported when a registry is configured.** Without one, capability calls are not resolved
   * at all, so every import would look unused — which would turn the first-look path into a page of
   * warnings about a host nobody described.
   */
  private reportUnusedImports(): void {
    if (this.registry === undefined) return;
    for (const [key, span] of this.importSpans) {
      if (this.usedCapabilities.has(key)) continue;
      const [, name] = [key.slice(0, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1)];
      const module = key.slice(0, key.lastIndexOf('.'));
      this.warn(
        'DS0290',
        `\`${name}\` is imported from \`${module}\` but never used`,
        span,
      );
    }
  }

  /**
   * Collect this module's components and entities.
   *
   * After `resolveBases`, so a component field typed as a record gets the flattened record; before
   * any body, so a query may name a component declared further down the file.
   */
  /**
   * Check every system's declarations against what its body does.
   *
   * After bodies are checked, because inference reads the same tree and a body with a type error in
   * it would produce access that is not worth reporting against.
   */
  private checkSystemAccess(module: Module): void {
    for (const decl of module.decls) {
      if (decl.kind !== 'system') continue;
      const inferred = this.access.get(decl.name) ?? { reads: new Set(), writes: new Set() };
      checkSystemDeclarations(decl, inferred, this.entityModel, (code, severity, message, span) => {
        if (severity === 'warning') this.warn(code, message, span);
        else this.report(code, message, span);
      });
    }
  }

  private collectEntities(module: Module): void {
    this.entityModel = collectEntityModel(module, {
      resolveTypeRef: (ref) => this.resolveTypeRef(ref),
      report: (code, message, span) => this.report(code, message, span),
      taken: (name) => this.data.has(name) || this.enums.has(name),
    });
    this.access = inferAccess(module, this.entityModel);
  }

  private collectData(decl: DataDecl): void {
    if (this.data.has(decl.name) || this.enums.has(decl.name)) {
      this.report('DS0206', `\`${decl.name}\` is declared more than once in this module`, decl.span);
      return;
    }

    const fields = new Map<string, Type>();
    for (const field of decl.fields) {
      if (fields.has(field.name)) {
        this.report(
          'DS0207',
          `\`${decl.name}\` declares the field \`${field.name}\` more than once`,
          field.span,
        );
        continue;
      }
      fields.set(field.name, this.resolveTypeRef(field.type));
    }
    /*
     * The base is recorded, not resolved.
     *
     * A base may be declared after the record that names it, and resolving here would make that an
     * error — a rule the language does not otherwise have for declarations, only for the types of
     * fields. So bases are a separate pass over everything collected, and `Type.base` is set there,
     * only when the clause turns out to be legal.
     */
    if (decl.base !== undefined) this.declaredBases.set(decl.name, decl.base);
    this.data.set(decl.name, { kind: 'data', name: decl.name, fields });
  }

  /**
   * Flatten each base chain into the record that names it, and refuse the three ways it goes wrong.
   *
   * **Depth-first with a three-colour marking**, because a cycle here is a record whose layout
   * contains itself and there is no smallest one — a walk without the marking does not return. Grey
   * means "on the current path": reaching a grey record is the cycle, and the path from it back to
   * itself is the whole cycle rather than the edge that closed it. A cycle reported as one edge
   * sends a reader to a file that looks correct in isolation.
   */
  private resolveBases(): void {
    const colour = new Map<string, 'grey' | 'black'>();
    const path: string[] = [];
    const broken = new Set<string>();

    const visit = (name: string): void => {
      const seen = colour.get(name);
      if (seen === 'black') return;

      if (seen === 'grey') {
        const at = path.indexOf(name);
        const cycle = [...path.slice(at), name];
        for (const member of cycle) broken.add(member);
        const clause = this.declaredBases.get(name);
        this.report(
          'DS0503',
          `\`${cycle.join('` extends `')}\`, which is a record whose layout contains itself.`,
          clause?.span ?? { start: 0, end: 0 },
        );
        return;
      }

      const clause = this.declaredBases.get(name);
      if (clause === undefined) {
        colour.set(name, 'black');
        return;
      }

      colour.set(name, 'grey');
      path.push(name);
      visit(clause.name);
      path.pop();
      colour.set(name, 'black');

      if (broken.has(name)) return;
      this.mergeBase(name, clause);
    };

    for (const name of this.declaredBases.keys()) visit(name);
  }

  /** Splice one record's base fields in front of its own, once the base is known to be legal. */
  private mergeBase(name: string, clause: { name: string; span: Span }): void {
    const own = this.data.get(name);
    if (own === undefined || own.kind !== 'data') return;

    /* Imported as well as local: a base in another file is the whole point of shipping modules and
       subtyping together, and an imported record arrives with its own chain already flattened. */
    const base = this.lookupData(clause.name);
    if (base === undefined || base.kind !== 'data') {
      this.report(
        'DS0505',
        this.lookupEnum(clause.name) !== undefined
          ? `\`${clause.name}\` is an enum, and a record may only extend a record.`
          : `\`${clause.name}\` is not a record in scope, so \`${name}\` cannot extend it. ` +
            'Declare it here or import it.',
        clause.span,
      );
      return;
    }

    const merged = new Map<string, Type>();
    for (const [field, type] of base.fields) merged.set(field, type);

    for (const [field, type] of own.fields) {
      if (merged.has(field)) {
        /* Both records are named. The reader has to open one of them and does not yet know which. */
        this.report(
          'DS0504',
          `\`${name}\` redeclares \`${field}\`, which it already has from \`${clause.name}\`. ` +
            'A subtype may add fields and never restate one, because the layout that gives would ' +
            'be two slots or one and neither answer is better than the question not existing.',
          clause.span,
        );
        continue;
      }
      merged.set(field, type);
    }

    /*
     * The map is rewritten in place rather than the type replaced.
     *
     * Another record may already hold this one as a field type, resolved before bases ran. Swapping
     * the object would leave that holder pointing at the unmerged version, which is a record missing
     * its inherited fields in exactly one place and no error anywhere.
     */
    const target = own.fields as Map<string, Type>;
    target.clear();
    for (const [field, type] of merged) target.set(field, type);

    this.data.set(name, { kind: 'data', name, fields: target, base });
  }

  private collectEnum(decl: EnumDecl): void {
    if (this.data.has(decl.name) || this.enums.has(decl.name)) {
      this.report('DS0206', `\`${decl.name}\` is declared more than once in this module`, decl.span);
      return;
    }

    const variants = new Map<string, Type | null>();
    for (const variant of decl.variants) {
      if (variants.has(variant.name)) {
        this.report(
          'DS0252',
          `\`${decl.name}\` declares the variant \`${variant.name}\` more than once`,
          variant.span,
        );
        continue;
      }
      variants.set(
        variant.name,
        variant.payload === undefined ? null : this.resolveTypeRef(variant.payload),
      );
    }
    this.enums.set(decl.name, { kind: 'enum', name: decl.name, variants });
  }

  private collectFn(decl: FnDecl): void {
    if (this.functions.has(decl.name)) {
      this.report('DS0209', `\`${decl.name}\` is declared more than once in this module`, decl.span);
      return;
    }
    this.functions.set(decl.name, {
      params: decl.params.map((p) => ({ name: p.name, type: this.resolveTypeRef(p.type) })),
      returns: decl.returnType === undefined ? VOID : this.resolveTypeRef(decl.returnType),
    });
  }

  /**
   * A task's signature, kept apart from the functions.
   *
   * **A task shares the function namespace but not the function table**, and both halves matter. It
   * shares the namespace because `fn settle()` beside `task settle()` is two things one name, which
   * is a collision whatever the second one is. It stays out of the table because a task is not
   * callable: `settle()` in an expression has no meaning, since a task finishes at a moment nobody
   * is standing at. `spawn` is how one starts, and the diagnostic for calling one says so.
   */
  private collectTask(decl: TaskDecl): void {
    if (this.functions.has(decl.name) || this.tasks.has(decl.name)) {
      this.report('DS0209', `\`${decl.name}\` is declared more than once in this module`, decl.span);
      return;
    }
    this.tasks.set(decl.name, {
      params: decl.params.map((p) => ({ name: p.name, type: this.resolveTypeRef(p.type) })),
      returns: VOID,
    });
  }

  private checkTask(decl: TaskDecl): void {
    const signature = this.tasks.get(decl.name);
    const scope = new Scope();
    decl.params.forEach((param, index) => {
      scope.declare(param.name, {
        type: signature?.params[index]?.type ?? ERROR,
        mutable: param.mutable,
      });
    });

    /* A task returns nothing, so a bare `return` is legal and a `return value` is not — which the
       existing statement check reports against this. */
    const previous = this.returns;
    const previousWorld = this.worldInScope;
    this.returns = VOID;
    this.inTask = true;
    this.worldInScope = this.worldParamOf(decl.params);
    for (const stmt of decl.body) this.checkStmt(stmt, scope);
    this.worldInScope = previousWorld;
    this.inTask = false;
    this.returns = previous;
  }

  private collectState(decl: StateDecl): void {
    if (this.states.has(decl.name)) {
      this.report('DS0209', `\`${decl.name}\` is declared more than once in this module`, decl.span);
      return;
    }
    this.states.set(decl.name, decl);
  }

  /**
   * A state's blocks.
   *
   * `enter` is a task body — it may suspend, and is cancelled if the state is left — so `inTask` is
   * set for it and not for an `on` handler, which runs inside the `send` that delivered the event
   * and has nowhere to be resumed.
   */
  private checkState(decl: StateDecl): void {
    const previousState = this.inState;
    this.inState = true;

    if (decl.enter !== undefined) {
      const previousTask = this.inTask;
      this.inTask = true;
      const scope = new Scope();
      for (const stmt of decl.enter) this.checkStmt(stmt, scope);
      this.inTask = previousTask;
    }

    for (const handler of decl.handlers) {
      const payload = this.events.get(handler.event);
      if (payload === undefined) {
        this.report(
          'DS0270',
          `\`${handler.event}\` is not an event declared in this module`,
          handler.span,
        );
      }
      const scope = new Scope();
      if (handler.binding !== undefined && payload !== undefined) {
        scope.declare(handler.binding, { type: payload, mutable: false });
      }
      for (const stmt of handler.body) this.checkStmt(stmt, scope);
    }

    this.inState = previousState;
  }

  /**
   * What is true of the machine as a whole rather than of one state.
   *
   * Run after every state is checked, because reachability is a property of the set: a `become` in
   * the last state can be the only thing that reaches the second.
   */
  private checkMachine(): void {
    if (this.states.size === 0) return;

    const reached = new Set<string>();
    const leaves = new Map<string, number>();
    const [initial] = this.states.keys();
    if (initial !== undefined) reached.add(initial);

    for (const [name, decl] of this.states) {
      let outgoing = 0;
      const walk = (stmts: readonly Stmt[]): void => {
        for (const stmt of stmts) {
          switch (stmt.kind) {
            case 'become':
              outgoing += 1;
              if (this.states.has(stmt.state)) reached.add(stmt.state);
              break;
            case 'if':
            case 'ifLet':
              walk(stmt.then);
              if (stmt.otherwise !== undefined) walk(stmt.otherwise);
              break;
            case 'while':
            case 'scope':
              walk(stmt.body);
              break;
            default:
              break;
          }
        }
      };
      if (decl.enter !== undefined) walk(decl.enter);
      for (const handler of decl.handlers) walk(handler.body);
      leaves.set(name, outgoing);
    }

    for (const [name, decl] of this.states) {
      if (!reached.has(name)) {
        this.warn(
          'DS0280',
          `\`${name}\` is a state nothing enters. The machine starts in \`${initial ?? ''}\`, and ` +
            'no `become` names this one.',
          decl.span,
        );
      }
      if ((leaves.get(name) ?? 0) === 0) {
        /*
         * A warning rather than an error, because a machine that ends is legitimate — but a state
         * with no way out is far more often one somebody meant to finish. Review found a test
         * whose machine had no exit and whose re-entrant guard was therefore deletable without any
         * suite noticing, which is the failure this makes visible.
         */
        this.warn(
          'DS0282',
          `\`${name}\` has no \`become\` out of it. If it is meant to be where the machine ends, ` +
            'that is fine and this is a note; if it is not, nothing will ever leave it.',
          decl.span,
        );
      }
    }
  }

  private collectEvent(decl: EventDecl): void {
    if (this.events.has(decl.name) || this.data.has(decl.name) || this.enums.has(decl.name)) {
      this.report('DS0209', `\`${decl.name}\` is declared more than once in this module`, decl.span);
      return;
    }
    const fields = new Map<string, Type>();
    const defaults = new Set<string>();
    for (const field of decl.fields) {
      fields.set(field.name, this.resolveTypeRef(field.type));
      if (field.default !== undefined) defaults.add(field.name);
    }
    this.events.set(decl.name, { kind: 'data', name: decl.name, fields });
    this.eventDefaults.set(decl.name, defaults);
  }

  /** An event's defaults are expressions like a record's, and are checked the same way. */
  private checkEventDefaults(decl: EventDecl): void {
    const scope = new Scope();
    for (const field of decl.fields) {
      if (field.default === undefined) continue;
      const declared = this.resolveTypeRef(field.type);
      const actual = this.checkExpr(field.default, scope, declared);
      if (!assignable(actual, declared)) {
        this.report(
          'DS0202',
          `\`${field.name}\` is declared \`${nameOf(declared)}\` but its default is ` +
            `\`${nameOf(actual)}\``,
          field.default.span,
        );
      }
    }
  }

  /**
   * A handler's body is an ordinary function body, so `await` and `scope` are refused inside it
   * with the messages they already carry: a handler runs inside the emitter's tick and has nowhere
   * to be resumed.
   */
  private checkOn(decl: OnDecl): void {
    const payload = this.events.get(decl.event);
    if (payload === undefined) {
      this.report('DS0270', `\`${decl.event}\` is not an event declared in this module`, decl.span);
      return;
    }
    const scope = new Scope();
    scope.declare(decl.binding, { type: payload, mutable: false });
    for (const stmt of decl.body) this.checkStmt(stmt, scope);
  }

  /**
   * Field defaults are checked in the second pass, not while collecting.
   *
   * A default may refer to a record declared later, so checking one during collection would fail on
   * a forward reference that is perfectly legal. The cost is walking the declarations twice; what
   * would make it wrong is a default that could observe the collection order, which none can.
   */
  private checkDataDefaults(decl: DataDecl): void {
    /*
     * Two fields resolving to one id.
     *
     * The realistic shape is `@id("phase")` on a field renamed to `beat` while another field is
     * still called `phase` — one id, two fields, and a migration that would write one value into
     * whichever it met first. Checked over the record's *own* fields: an inherited one carries the
     * base's owner, so it cannot collide with a field declared here.
     */
    const ids = new Map<string, string>();
    for (const field of decl.fields) {
      const id = field.id ?? field.name;
      const first = ids.get(id);
      if (first !== undefined) {
        this.report(
          'DS0284',
          `\`${field.name}\` and \`${first}\` would have the same field id \`${id}\`, so a ` +
            'migration could not tell which value belongs to which',
          field.span,
        );
        continue;
      }
      ids.set(id, field.name);
    }

    const scope = new Scope();
    for (const field of decl.fields) {
      if (field.default === undefined) continue;
      const declared = this.resolveTypeRef(field.type);
      const actual = this.checkExpr(field.default, scope, declared);
      if (!assignable(actual, declared)) {
        this.report(
          'DS0202',
          `\`${field.name}\` is declared \`${nameOf(declared)}\` but its default is ` +
            `\`${nameOf(actual)}\``,
          field.default.span,
        );
      }
    }
  }

  /**
   * A system's `update` body, checked like a function with no parameters and no return.
   *
   * A system takes nothing and returns nothing: everything it touches, it reaches through a query.
   * That is what makes its declarations checkable at all — there is no argument through which a
   * component could arrive unaccounted for.
   */
  /**
   * Refuse every `await` inside a query loop's body, however deeply nested.
   *
   * Walks into every statement that holds statements. A version that checked only the loop's direct
   * statements would pass an `await` one `if` deep, which is where one would actually be written.
   */
  private refuseSuspension(body: readonly Stmt[]): void {
    for (const stmt of body) {
      switch (stmt.kind) {
        case 'await':
        case 'awaitTask':
          this.report(
            'DS0289',
            'a query loop may not `await`. Its cursor comes from a pool and is given back when the ' +
              'loop ends, and a suspension holds one across a frame — where the entity model ' +
              'already says the result is invalid, because the array it walks has been rewritten ' +
              'by every system that ran since. Collect what you need, end the loop, then await.',
            stmt.span,
          );
          break;
        case 'if':
        case 'ifLet':
          this.refuseSuspension(stmt.then);
          if (stmt.otherwise != null) this.refuseSuspension(stmt.otherwise);
          break;
        case 'while':
        case 'scope':
        case 'forQuery':
          this.refuseSuspension(stmt.body);
          break;
        default:
          break;
      }
    }
  }

  /**
   * A prefab names components that exist, and gives each field a constant.
   *
   * **A prefab is a description the host instantiates from data it holds.** A value computed at
   * spawn time would make it a program — and the thing that makes a prefab worth having is that it
   * can be inspected, serialised and edited without being run. `definePrefab` takes values, not
   * thunks, so a non-constant has nowhere to go on the other side either.
   *
   * A component named here that no declaration reaches is a compile error rather than the runtime
   * refusal the interim binding gives, which is what the language owning a component's shape buys.
   */
  private checkPrefab(decl: PrefabDecl): void {
    const scope = new Scope();
    for (const component of decl.components) {
      const declared = this.entityModel.components.get(component.name);
      if (declared === undefined) {
        this.report(
          'DS0286',
          `\`${component.name}\` is not a component in this module, so a prefab cannot put one on ` +
            'an entity',
          component.span,
        );
        continue;
      }

      for (const value of component.values) {
        const field = declared.type.kind === 'data' ? declared.type.fields.get(value.name) : undefined;
        if (field === undefined) {
          this.report(
            'DS0203',
            `\`${component.name}\` has no field \`${value.name}\``,
            value.span,
          );
          continue;
        }
        const actual = this.checkExpr(value.value, scope, field);
        if (actual.kind !== 'error' && !assignable(actual, field)) {
          this.report(
            'DS0208',
            `cannot put \`${nameOf(actual)}\` in \`${component.name}.${value.name}\`, which is ` +
              `\`${nameOf(field)}\``,
            value.span,
          );
          continue;
        }
        if (!isConstantExpr(value.value)) {
          this.report(
            'DS0297',
            `\`${component.name}.${value.name}\` is not a constant. A prefab is a description a ` +
              'host instantiates from data it holds, so a value computed when something spawns has ' +
              'nowhere to be computed — write the constant here and change it after instantiating.',
            value.span,
          );
        }
      }
    }
  }

  private checkSystem(decl: SystemDecl): void {
    const scope = new Scope();
    const previous = this.returns;
    const previousWorld = this.worldInScope;
    this.returns = VOID;
    /* A system's world is the view the schedule hands it, bound under `SYSTEM_VIEW` in its body and
       taken as its generated function's only parameter. Declared in the scope as well as recorded
       for the plans, so `ecs.destroy(world, e)` resolves like any other name. */
    this.worldInScope = SYSTEM_VIEW;
    scope.declare(SYSTEM_VIEW, {
      type: { kind: 'data', name: 'World', fields: new Map() },
      mutable: false,
    });
    for (const stmt of decl.body) this.checkStmt(stmt, scope);
    this.worldInScope = previousWorld;
    this.returns = previous;
  }

  /**
   * The `World` parameter a body declares, or null — and a refusal when it declares two.
   *
   * Matched on the **written** type name rather than on the resolved type, because a checker with
   * no registry resolves no opaque type at all and a language server open on a file with no project
   * configured must still get this right. A consumer with their own `data World` shadows the
   * capability's, which is a name collision they can see, rather than a query that silently runs
   * against the wrong thing.
   */
  private worldParamOf(params: readonly { name: string; type: TypeRef }[]): string | null {
    const worlds = params.filter((p) => p.type.kind === 'named' && p.type.name === 'World');
    if (worlds.length > 1) {
      this.report(
        'DS0296',
        'two `World` parameters, so a query in this body would not say which one it runs against. ' +
          'Take one, or split the body.',
        (worlds[1] as { type: TypeRef }).type.span,
      );
      return null;
    }
    return worlds[0]?.name ?? null;
  }

  private checkFn(decl: FnDecl): void {
    const signature = this.functions.get(decl.name);
    const scope = new Scope();
    /*
     * Parameter types come from the collected signature rather than being resolved again.
     *
     * Resolving twice reports an unknown type twice, which is the cascade this checker exists to
     * avoid — and it is the subtle kind, because both reports are correct and only their number is
     * wrong. Caught by the test that asserts one unknown type yields one diagnostic.
     */
    decl.params.forEach((param, index) => {
      scope.declare(param.name, {
        type: signature?.params[index]?.type ?? ERROR,
        mutable: param.mutable,
      });
    });

    const previous = this.returns;
    const previousWorld = this.worldInScope;
    this.returns = signature?.returns ?? VOID;
    this.worldInScope = this.worldParamOf(decl.params);
    for (const stmt of decl.body) this.checkStmt(stmt, scope);
    this.worldInScope = previousWorld;

    /*
     * A function that declares a return type must return on every path.
     *
     * Checked structurally rather than by a flow graph: the last statement has to be a `return`, or
     * an `if` whose branches all do. That is stricter than real reachability analysis — a `while
     * true` that never falls through is rejected — and it is chosen because a wrong *acceptance*
     * here is a function returning nothing into a typed hole, where a wrong rejection is a
     * diagnostic somebody reads and works around with an explicit `return`.
     */
    if (this.returns.kind !== 'void' && !this.alwaysReturns(decl.body)) {
      this.report(
        'DS0251',
        `\`${decl.name}\` declares \`${nameOf(this.returns)}\` but can finish without returning`,
        decl.span,
      );
    }
    this.returns = previous;
  }

  private alwaysReturns(body: readonly Stmt[]): boolean {
    const last = body[body.length - 1];
    if (last === undefined) return false;
    if (last.kind === 'return') return true;
    if (last.kind === 'if' || last.kind === 'ifLet') {
      return (
        last.otherwise !== undefined &&
        this.alwaysReturns(last.then) &&
        this.alwaysReturns(last.otherwise)
      );
    }
    return false;
  }

  private checkStmt(stmt: Stmt, scope: Scope): void {
    switch (stmt.kind) {
      case 'let': {
        const declared = stmt.type === undefined ? undefined : this.resolveTypeRef(stmt.type);
        const actual = this.checkExpr(stmt.value, scope, declared);
        if (declared !== undefined && !assignable(actual, declared)) {
          this.report(
            'DS0208',
            `\`${stmt.name}\` is declared \`${nameOf(declared)}\` but its value is ` +
              `\`${nameOf(actual)}\``,
            stmt.value.span,
          );
        }
        scope.declare(stmt.name, { type: declared ?? actual, mutable: stmt.mutable });
        return;
      }

      case 'assign': {
        /*
         * Assigning *to* a query binding, rather than through it.
         *
         * The binding is `mut` so a write into component storage works — see the loop case. That
         * makes `e = other` type-check, and it reads as moving the loop somewhere, which it does
         * not: the cursor decides what comes next and nothing here touches it.
         */
        if (stmt.target.kind === 'ident' && this.queryRequirements.has(stmt.target.name)) {
          this.report(
            'DS0285',
            `\`${stmt.target.name}\` is the entity this loop is on, and assigning to it does not ` +
              'move the loop — the query decides what comes next. Write through it instead, or ' +
              'use a `let` for the handle you meant.',
            stmt.span,
          );
          return;
        }
        const target = this.checkExpr(stmt.target, scope);
        const value = this.checkExpr(stmt.value, scope, target);
        this.checkWritable(stmt.target, scope);
        if (target.kind === 'error' || value.kind === 'error') return;
        if (!assignable(value, target)) {
          this.report(
            'DS0208',
            `cannot assign \`${nameOf(value)}\` to \`${nameOf(target)}\``,
            stmt.span,
          );
        }
        return;
      }

      case 'compoundAssign': {
        const target = this.checkExpr(stmt.target, scope);
        const value = this.checkExpr(stmt.value, scope, target);
        this.checkWritable(stmt.target, scope);
        if (target.kind === 'error' || value.kind === 'error') return;
        if (!assignable(value, target)) {
          this.report(
            'DS0208',
            `cannot assign \`${nameOf(value)}\` to \`${nameOf(target)}\``,
            stmt.span,
          );
          return;
        }
        /*
         * A compound assignment is arithmetic, so its operands must be numeric.
         *
         * Checked after assignability rather than instead of it, because `label += label` is two
         * different mistakes — the types agree and the operation still means nothing on text. There
         * is no string concatenation operator, deliberately: `+` on text is where a language
         * acquires an implicit conversion.
         */
        if (!isNumeric(target)) {
          this.report(
            'DS0208',
            `\`${stmt.op}\` needs a numeric operand but found \`${nameOf(target)}\``,
            stmt.span,
          );
        }
        return;
      }

      case 'return': {
        if (stmt.value === undefined) {
          if (this.returns.kind !== 'void') {
            this.report(
              'DS0253',
              `this function returns \`${nameOf(this.returns)}\`, so \`return\` needs a value`,
              stmt.span,
            );
          }
          return;
        }
        const actual = this.checkExpr(stmt.value, scope, this.returns);
        if (!assignable(actual, this.returns)) {
          this.report(
            'DS0254',
            `this function returns \`${nameOf(this.returns)}\` but this is \`${nameOf(actual)}\``,
            stmt.value.span,
          );
        }
        return;
      }

      case 'if': {
        this.checkCondition(stmt.condition, scope);
        const thenScope = scope.child();
        for (const inner of stmt.then) this.checkStmt(inner, thenScope);
        if (stmt.otherwise !== undefined) {
          const elseScope = scope.child();
          for (const inner of stmt.otherwise) this.checkStmt(inner, elseScope);
        }
        return;
      }

      case 'ifLet': {
        const subject = this.checkExpr(stmt.subject, scope);
        const bodyScope = scope.child();
        if (subject.kind === 'option') {
          bodyScope.declare(stmt.name, { type: subject.inner, mutable: false });
        } else {
          if (subject.kind !== 'error') {
            this.report(
              'DS0223',
              `\`if let\` needs an option but this is \`${nameOf(subject)}\``,
              stmt.subject.span,
            );
          }
          bodyScope.declare(stmt.name, { type: ERROR, mutable: false });
        }
        for (const inner of stmt.then) this.checkStmt(inner, bodyScope);
        if (stmt.otherwise !== undefined) {
          const elseScope = scope.child();
          for (const inner of stmt.otherwise) this.checkStmt(inner, elseScope);
        }
        return;
      }

      case 'while': {
        this.checkCondition(stmt.condition, scope);
        const body = scope.child();
        this.loopDepth += 1;
        for (const inner of stmt.body) this.checkStmt(inner, body);
        this.loopDepth -= 1;
        return;
      }

      case 'loopJump': {
        if (this.loopDepth === 0) {
          /*
           * One code for both words, because it is one mistake: a jump with no loop to jump in.
           * Two codes would split a consumer's grep across a distinction that changes nothing about
           * what they have to do, which is the same call `checkConversion` makes for `DS0233`.
           */
          this.report(
            'DS0238',
            `\`${stmt.word}\` is only meaningful inside a loop, and there is none here`,
            stmt.span,
          );
        }
        return;
      }

      case 'forQuery': {
        const world = this.worldInScope;
        if (world === null) {
          this.report(
            'DS0295',
            'a query needs a world to run against and there is none in scope. A `system` has one ' +
              'and every query in one uses it; anywhere else, declare a `World` parameter and the ' +
              'query runs against that.',
            stmt.span,
          );
          return;
        }

        const terms = [...stmt.query.required, ...stmt.query.with, ...stmt.query.without].map(
          (ref) => (ref.kind === 'option' ? '' : ref.name),
        );
        const { names, unknown } = requiredComponents(terms, this.entityModel);
        for (const name of unknown) {
          this.report(
            'DS0286',
            `\`${name}\` is not a component or an entity in this module. A query narrows by ` +
              'component, and a name that is neither would narrow by nothing.',
            stmt.query.span,
          );
        }

        /*
         * `without` terms are required to *exist* and are deliberately not readable in the body.
         * An entity a `without` matched is not in the result at all, so a field read through one
         * would be a read of a component the loop proved absent.
         */
        const excluded = new Set(
          requiredComponents(
            stmt.query.without.map((ref) => (ref.kind === 'option' ? '' : ref.name)),
            this.entityModel,
          ).names,
        );
        const readable = new Set(names.filter((name) => !excluded.has(name)));

        /*
         * A query loop may not `await`, and the refusal is here rather than at the `await`.
         *
         * The cursor comes from a pool and is given back when the loop ends. A suspension holds one
         * across a frame boundary, where the entity model already says the result is invalid — the
         * dense array it is walking has been swapped and rewritten by every system that ran since.
         * Reporting it at the loop rather than at each `await` names the thing that has to change.
         *
         * It is also what keeps the task rewriter out of the loop lowering: a `for` with no
         * suspension inside it is one block to `emit/task.ts` rather than a state machine, and that
         * simplification is bought by a refusal that is correct on its own terms.
         */
        this.refuseSuspension(stmt.body);

        /*
         * The plan is built here, where the expansion of an `entity` term is already in hand.
         *
         * `views` is one entry per component the body touches rather than one per required
         * component: a loop requiring four and reading one takes one view, and asking for the other
         * three would make a read-only system demand access the engine would refuse.
         */
        const touched = accessOfBody(stmt.body, this.entityModel, this.access);
        this.queries.set(stmt, {
          world,
          required: names.filter((name) => !excluded.has(name)),
          excluded: [...excluded],
          /*
           * Ordered by the query's own terms, not by the order the body happened to touch them.
           *
           * A set's insertion order puts every written component last, because `writes` implies
           * `reads` and the implication is applied at the end — which is an order no reader of the
           * source could predict, and it would decide the names of the temporaries in generated
           * code. Source order is stable across compiles and matches what somebody wrote.
           */
          views: names
            .filter((component) => readable.has(component) && touched.reads.has(component))
            .map((component) => ({ component, forWriting: touched.writes.has(component) })),
        });

        const body = scope.child();
        /*
         * The binding is not `mut`, and writing through it works anyway — see `checkWritable`,
         * which treats a handle as an address rather than a container. So `e.Hunger.value = 1`
         * writes a column, and `e = other` is still refused for what it is: the loop's own
         * position, which assigning to does not move.
         */
        body.declare(stmt.binding, { type: { kind: 'entity' }, mutable: false });
        /* Saved and restored by name, so a loop shadowing an outer binding's name gives the name
           back rather than leaving the inner loop's requirements attached to it. */
        const shadowed = this.queryRequirements.get(stmt.binding);
        this.queryRequirements.set(stmt.binding, readable);
        this.loopDepth += 1;
        for (const inner of stmt.body) this.checkStmt(inner, body);
        this.loopDepth -= 1;
        if (shadowed === undefined) this.queryRequirements.delete(stmt.binding);
        else this.queryRequirements.set(stmt.binding, shadowed);
        return;
      }

      case 'await': {
        if (!this.inTask) {
          this.report(
            'DS0266',
            'only a task can `await`: an ordinary function runs to its end inside one tick, and ' +
              'there is nowhere for it to be resumed',
            stmt.span,
          );
          return;
        }
        /*
         * A duration is a number of seconds, because units erase at the literal: `500ms` is already
         * `0.5` by the time anything downstream sees it. So there is no `Duration` type to check
         * against, and checking against `f32` is checking the real thing rather than a proxy.
         */
        const declared = primitive('f32');
        const actual = this.checkExpr(stmt.duration, scope, declared);
        if (!assignable(actual, declared)) {
          this.report(
            'DS0265',
            `a duration is a number of seconds, and this is \`${nameOf(actual)}\``,
            stmt.duration.span,
          );
        }
        return;
      }

      case 'scope': {
        if (!this.inTask) {
          /* A scope in a function is created, filled and left inside one tick, so everything it
             started is cancelled before the function returns. It reads as ownership and is a way
             of spawning nothing. */
          this.report(
            'DS0267',
            'only a task can hold a `scope` open: in a function it would be left on the same ' +
              'tick it was opened, cancelling everything spawned into it',
            stmt.span,
          );
          return;
        }
        const body = scope.child();
        for (const inner of stmt.body) this.checkStmt(inner, body);
        return;
      }

      case 'become': {
        if (!this.inState) {
          this.report(
            'DS0283',
            'only a `state` can `become`: a transition is a change to a machine, and outside one ' +
              'there is no machine to change',
            stmt.span,
          );
          return;
        }
        if (!this.states.has(stmt.state)) {
          this.report('DS0281', `\`${stmt.state}\` is not a state declared in this module`, stmt.span);
        }
        return;
      }

      case 'awaitTask': {
        if (!this.inTask) {
          this.report(
            'DS0266',
            'only a task can `await`: an ordinary function runs to its end inside one tick, and ' +
              'there is nowhere for it to be resumed',
            stmt.span,
          );
          return;
        }
        const signature = this.tasks.get(stmt.task);
        if (signature === undefined) {
          /*
           * A name ending in `Time` is almost always a mistyped clock, and the parser can no longer
           * say so: `await` takes a task or a clock, so anything not one of the three names parses
           * as a task and reaches here. Naming the three costs a clause and saves the reader the
           * round trip of finding out that clocks are a closed set.
           */
          const clockish = stmt.task.endsWith('Time');
          this.report(
            'DS0268',
            this.functions.has(stmt.task)
              ? `\`${stmt.task}\` is a function, not a task. A function has already finished by ` +
                  'the time the call returns, so there is nothing to await.'
              : `\`${stmt.task}\` is not a task declared in this module` +
                  (clockish
                    ? '. The clocks are `fixedTime`, `frameTime` and `wallTime`, and there are no others.'
                    : ''),
            stmt.span,
          );
          return;
        }
        if (stmt.args.length !== signature.params.length) {
          this.report(
            'DS0269',
            `\`${stmt.task}\` takes ${signature.params.length} argument` +
              `${signature.params.length === 1 ? '' : 's'} but ${stmt.args.length} ` +
              `${stmt.args.length === 1 ? 'was' : 'were'} given`,
            stmt.span,
          );
          return;
        }
        stmt.args.forEach((arg, index) => {
          const declared = signature.params[index]?.type ?? ERROR;
          const actual = this.checkExpr(arg, scope, declared);
          if (!assignable(actual, declared)) {
            this.report(
              'DS0269',
              `\`${stmt.task}\` expects \`${nameOf(declared)}\` here but was given ` +
                `\`${nameOf(actual)}\``,
              arg.span,
            );
          }
        });
        return;
      }

      case 'emit': {
        const payload = this.events.get(stmt.event);
        if (payload === undefined) {
          this.report(
            'DS0270',
            this.data.has(stmt.event)
              ? `\`${stmt.event}\` is a record, not an event. Only an \`event\` declaration can be ` +
                  'emitted, so that a typo cannot name something never meant to travel.'
              : `\`${stmt.event}\` is not an event declared in this module`,
            stmt.span,
          );
          return;
        }
        if (payload.kind !== 'data') return;

        const given = new Set<string>();
        for (const field of stmt.fields) {
          const declared = payload.fields.get(field.name);
          if (declared === undefined) {
            this.report(
              'DS0271',
              `\`${stmt.event}\` has no field \`${field.name}\``,
              field.span,
            );
            this.checkExpr(field.value, scope);
            continue;
          }
          given.add(field.name);
          const actual = this.checkExpr(field.value, scope, declared);
          if (!assignable(actual, declared)) {
            this.report(
              'DS0271',
              `\`${field.name}\` is \`${nameOf(declared)}\` but was given \`${nameOf(actual)}\``,
              field.value.span,
            );
          }
        }

        for (const [name] of payload.fields) {
          if (given.has(name) || this.eventDefaults.get(stmt.event)?.has(name) === true) continue;
          this.report(
            'DS0271',
            `\`${stmt.event}\` needs \`${name}\`, which has no default to fall back on`,
            stmt.span,
          );
        }
        return;
      }

      case 'spawn': {
        const signature = this.tasks.get(stmt.task);
        if (signature === undefined) {
          this.report(
            'DS0268',
            this.functions.has(stmt.task)
              ? `\`${stmt.task}\` is a function, not a task, so it is called rather than spawned`
              : `\`${stmt.task}\` is not a task declared in this module`,
            stmt.span,
          );
          return;
        }
        if (stmt.args.length !== signature.params.length) {
          this.report(
            'DS0269',
            `\`${stmt.task}\` takes ${signature.params.length} argument` +
              `${signature.params.length === 1 ? '' : 's'} but ${stmt.args.length} ` +
              `${stmt.args.length === 1 ? 'was' : 'were'} given`,
            stmt.span,
          );
          return;
        }
        stmt.args.forEach((arg, index) => {
          const declared = signature.params[index]?.type ?? ERROR;
          const actual = this.checkExpr(arg, scope, declared);
          if (!assignable(actual, declared)) {
            this.report(
              'DS0269',
              `\`${stmt.task}\` expects \`${nameOf(declared)}\` here but was given ` +
                `\`${nameOf(actual)}\``,
              arg.span,
            );
          }
        });
        return;
      }

      case 'expr':
        this.checkExpr(stmt.expr, scope);
        return;
    }
  }

  private checkCondition(expr: Expr, scope: Scope): void {
    const type = this.checkExpr(expr, scope, BOOL);
    if (type.kind === 'error' || isBool(type)) return;
    this.report(
      'DS0255',
      `a condition must be \`bool\` but this is \`${nameOf(type)}\`. There is no truthiness in ` +
        'this language; compare explicitly.',
      expr.span,
    );
  }

  /**
   * Whether a target may be written through, reported at the root of the path.
   *
   * `state.a.b = …` is refused because `state` is immutable, not because `b` is. Naming the root is
   * what tells a reader which `mut` to add; naming the leaf sends them to the wrong line.
   */
  private checkWritable(target: Expr, scope: Scope): void {
    let root = target;
    while (root.kind === 'member' || root.kind === 'optionalMember') root = root.target;
    if (root.kind !== 'ident') return;

    const binding = scope.lookup(root.name);
    if (binding === undefined && this.lookupConst(root.name) !== undefined) {
      /* Reported here rather than falling through the `undefined` return below, which exists for a
         name nothing declared — and a module constant is very much declared. */
      this.report(
        'DS0241',
        `\`${root.name}\` is a module constant, so it cannot be written to`,
        target.span,
      );
      return;
    }
    if (binding === undefined || binding.mutable) return;

    /*
     * **An entity handle is an address, and `mut` is about containers.**
     *
     * `e.Hunger.value = 1` does not modify `e`. It writes a column in the world's storage, and the
     * handle is how that column is found — the same relationship a record has to a field is not the
     * relationship a handle has to a component. Requiring `mut` here would mean every system
     * parameter and every loop binding carried a keyword that described the wrong thing, and a
     * reader would conclude that dropping it made the write not happen.
     *
     * **What this gives up** is that a handle cannot be marked read-only. **What would make it
     * wrong** is a language where a handle could be reassigned to name a different entity and the
     * distinction mattered — which is why assigning *to* a query binding is refused separately.
     */
    if (binding.type.kind === 'entity') return;

    this.report(
      'DS0201',
      `\`${root.name}\` is not declared \`mut\`, so it cannot be written through`,
      target.span,
    );
  }

  /**
   * The type of an expression.
   *
   * `expected` is a hint, not a constraint. It exists for the forms that cannot be typed from the
   * inside — `none`, which is an option of *something*; `Ok(v)`, whose error half is unknowable
   * from the expression; and an integer literal, which has no width until something gives it one.
   * It is never used to coerce. A checker that let an expectation change a well-typed expression's
   * type would be doing inference, and inference is what makes an error point at the wrong line.
   */
  private checkExpr(expr: Expr, scope: Scope, expected?: Type): Type {
    switch (expr.kind) {
      case 'number':
        /*
         * A bare numeric literal is `f32` unless an expectation says otherwise.
         *
         * The engine's own maths is single precision throughout, so `f32` is the default a script
         * author almost always wants. The expectation is honoured for integers and `f64` because
         * `let n: u8 = 3` should not be a conversion error over a literal that fits — a literal has
         * no width of its own until something gives it one.
         */
        if (
          expected !== undefined &&
          expected.kind === 'primitive' &&
          (INTEGERS.has(expected.name) || expected.name === 'f64')
        ) {
          return this.record(expr, expected);
        }
        return this.record(expr, primitive('f32'));

      case 'string':
        return this.record(expr, STRING);

      case 'bool':
        return this.record(expr, BOOL);

      case 'ident': {
        if (expr.name === 'none') {
          if (expected?.kind === 'option') return this.record(expr, expected);
          this.report(
            'DS0224',
            '`none` needs a type from its context; annotate the binding it is assigned to',
            expr.span,
          );
          return this.record(expr, ERROR);
        }
        const binding = scope.lookup(expr.name);
        if (binding !== undefined) return this.record(expr, binding.type);
        /* After the scope, so a local shadows a module constant the way it shadows anything else,
           and before the function check, so a constant is not reported as "call it". */
        const constant = this.lookupConst(expr.name);
        if (constant !== undefined) return this.record(expr, constant);
        if (this.lookupFn(expr.name) !== undefined || BUILTIN_CONSTRUCTORS.has(expr.name)) {
          this.report(
            'DS0264',
            `\`${expr.name}\` is a function; call it rather than using it as a value`,
            expr.span,
          );
          return this.record(expr, ERROR);
        }
        this.report('DS0205', `\`${expr.name}\` is not defined`, expr.span);
        return this.record(expr, ERROR);
      }

      case 'member': {
        /*
         * `Light.Red` names a variant, and it is resolved before the target is checked as a value.
         *
         * An enum's *name* is not a binding, so checking the target first would report "not
         * defined" for a perfectly ordinary variant reference. The order matters rather than the
         * lookup: a local named `Light` shadows the type, which is why the scope is consulted first.
         */
        if (expr.target.kind === 'ident' && scope.lookup(expr.target.name) === undefined) {
          const declared = this.lookupEnum(expr.target.name);
          if (declared !== undefined && declared.kind === 'enum') {
            return this.record(expr, this.variantValue(declared, expr.name, expr.span));
          }
        }
        const target = this.checkExpr(expr.target, scope);
        if (target.kind === 'entity') {
          const binding = expr.target.kind === 'ident' ? expr.target.name : null;
          return this.record(expr, this.componentOf(binding, expr.name, expr.span));
        }
        return this.record(expr, this.fieldOf(target, expr.name, expr.span));
      }

      case 'optionalMember': {
        const target = this.checkExpr(expr.target, scope);
        if (target.kind === 'error') return this.record(expr, ERROR);
        if (target.kind !== 'option') {
          this.report(
            'DS0225',
            `\`?.\` needs an option but this is \`${nameOf(target)}\`; use \`.\``,
            expr.span,
          );
          return this.record(expr, ERROR);
        }
        /*
         * The result is an option, and that is the whole point of the operator.
         *
         * The design says the compiler preserves the fact that the operation may not have run: an
         * expression whose effect is conditional must not be treated as unconditional downstream.
         * So `a?.b` is `B?`, and reading it needs `if let` like any other option.
         */
        const inner = this.fieldOf(target.inner, expr.name, expr.span);
        return this.record(expr, inner.kind === 'error' ? ERROR : option(inner));
      }

      case 'unary': {
        const operand = this.checkExpr(expr.operand, scope, expected);
        if (operand.kind === 'error') return this.record(expr, ERROR);
        if (expr.op === '!') {
          if (!isBool(operand)) {
            this.report(
              'DS0256',
              `\`!\` needs a \`bool\` but this is \`${nameOf(operand)}\``,
              expr.span,
            );
            return this.record(expr, ERROR);
          }
          return this.record(expr, BOOL);
        }
        if (!isNumeric(operand)) {
          this.report('DS0256', `\`-\` needs a number but this is \`${nameOf(operand)}\``, expr.span);
          return this.record(expr, ERROR);
        }
        return this.record(expr, operand);
      }

      case 'binary':
        return this.record(expr, this.checkBinary(expr, scope));

      case 'call':
        return this.record(expr, this.checkCall(expr, scope, expected));

      case 'record':
        return this.record(expr, this.checkRecord(expr, scope));

      case 'try':
        return this.record(expr, this.checkTry(expr, scope));

      case 'match':
        return this.record(expr, this.checkMatch(expr, scope, expected));
    }
  }

  /**
   * The type of `EnumName.Variant` used as a value.
   *
   * A payload-free variant *is* a value of the enum. A payload variant is a constructor and needs
   * calling — reported here rather than silently typed as the enum, because `Shape.Circle` without
   * its argument is a function reference the language has no type for and would otherwise flow on
   * as an ordinary value.
   */
  private variantValue(declared: Type & { kind: 'enum' }, name: string, span: Span): Type {
    const payload = declared.variants.get(name);
    if (payload === undefined) {
      this.report('DS0216', `\`${declared.name}\` has no variant \`${name}\``, span);
      return ERROR;
    }
    if (payload !== null) {
      this.report(
        'DS0219',
        `\`${declared.name}.${name}\` carries a value, so it must be called: ` +
          `\`${declared.name}.${name}(…)\``,
        span,
      );
      return ERROR;
    }
    return declared;
  }

  /**
   * `e.Health` — the component named on an entity handle.
   *
   * **Refusing a component the loop did not require is the point of this method.** The entity model
   * enforces a system's declarations at runtime and answers a read of an undeclared component by
   * refusing; catching it here is what makes the declaration a diagnostic instead of a crash three
   * frames in, which is the argument for treating these forms as language rather than as library
   * calls.
   *
   * Outside a query loop there is nothing to check against, so a handle held in an ordinary
   * variable reaches any component it names. That is the honest position — the loop is what knows
   * what was required — and it is why a handle is a `for` binding in every corpus file.
   */
  private componentOf(binding: string | null, name: string, span: Span): Type {
    const component = this.entityModel.components.get(name);
    if (component === undefined) {
      this.report(
        'DS0286',
        `\`${name}\` is not a component in this module`,
        span,
      );
      return ERROR;
    }
    const required = binding === null ? undefined : this.queryRequirements.get(binding);
    if (required !== undefined && !required.has(name)) {
      this.report(
        'DS0285',
        `the loop that bound \`${binding ?? '?'}\` did not require \`${name}\`, so the entity it ` +
          `yields may not have one. Add it to that query — \`.with<${name}>()\` narrows without ` +
          'yielding it.',
        span,
      );
      return ERROR;
    }
    return component.type;
  }

  private fieldOf(target: Type, name: string, span: Span): Type {
    if (target.kind === 'error') return ERROR;
    if (target.kind !== 'data') {
      this.report(
        'DS0203',
        `\`${nameOf(target)}\` has no fields, so \`.${name}\` is not available`,
        span,
      );
      return ERROR;
    }
    const field = target.fields.get(name);
    if (field === undefined) {
      this.report('DS0203', `\`${target.name}\` has no field \`${name}\``, span);
      return ERROR;
    }
    return field;
  }

  private checkBinary(expr: Extract<Expr, { kind: 'binary' }>, scope: Scope): Type {
    let left = this.checkExpr(expr.left, scope);
    const right = this.checkExpr(expr.right, scope, left.kind === 'error' ? undefined : left);
    if (left.kind === 'error' || right.kind === 'error') return ERROR;

    /*
     * A bare literal on the **left** adapts to the right, as one on the right already adapted.
     *
     * The left is checked with no expected type — there is nothing yet to expect — so `1` falls to
     * its default and then disagrees with an `f64` on the other side. `a - 1` compiled and `1 - a`
     * did not, for the same `a`: an arithmetic rule that depends on which side the constant is
     * written on, and the first thing a consumer writing `f64` meets.
     *
     * Only a **literal** adapts, and only when the two disagree. Re-checking anything else would
     * be implicit widening between two typed operands, which this language refuses on purpose —
     * and re-checking an expression that reports would report it twice, which a number cannot.
     */
    if (expr.left.kind === 'number' && isNumeric(left) && isNumeric(right) && !same(left, right)) {
      left = this.checkExpr(expr.left, scope, right);
    }

    if (expr.op === '&&' || expr.op === '||') {
      if (!isBool(left) || !isBool(right)) {
        this.report(
          'DS0257',
          `\`${expr.op}\` needs two \`bool\` operands but found \`${nameOf(left)}\` and ` +
            `\`${nameOf(right)}\``,
          expr.span,
        );
        return ERROR;
      }
      return BOOL;
    }

    if (expr.op === '==' || expr.op === '!=') {
      if (!same(left, right)) {
        this.report(
          'DS0258',
          `cannot compare \`${nameOf(left)}\` with \`${nameOf(right)}\``,
          expr.span,
        );
        return ERROR;
      }
      return BOOL;
    }

    if (!isNumeric(left) || !isNumeric(right)) {
      this.report(
        'DS0259',
        `\`${expr.op}\` needs numeric operands but found \`${nameOf(left)}\` and ` +
          `\`${nameOf(right)}\``,
        expr.span,
      );
      return ERROR;
    }
    if (!same(left, right)) {
      /* The conversions named are the ones that apply to what is actually here. A message that
         offered `checked`, `clamp` and `wrap` to somebody holding two floats sent them to `DS0232`,
         which told them floats have no conversions — a two-step path to a dead end. */
      const spellings =
        isFloat(left) && isFloat(right)
          ? `\`${nameOf(left)}.nearest\` or \`${nameOf(right)}.nearest\``
          : '`checked`, `clamp` or `wrap`';
      this.report(
        'DS0230',
        `\`${expr.op}\` needs both operands to be the same type, but found \`${nameOf(left)}\` ` +
          `and \`${nameOf(right)}\`. There is no implicit widening; convert one explicitly with ` +
          `${spellings}.`,
        expr.span,
      );
      return ERROR;
    }

    /*
     * The overflow spellings are only meaningful on integers.
     *
     * Floats do not wrap and do not saturate, so `a +% b` on `f32` is a request the language cannot
     * honour. Reporting it beats accepting it as a synonym for `+`, which would teach that the
     * distinction is decorative.
     */
    if (expr.op.length === 2 && (expr.op.endsWith('%') || expr.op.endsWith('|'))) {
      if (left.kind === 'primitive' && !INTEGERS.has(left.name)) {
        this.report(
          'DS0231',
          `\`${expr.op}\` is wrapping or saturating arithmetic and needs an integer, but this is ` +
            `\`${nameOf(left)}\``,
          expr.span,
        );
        return ERROR;
      }
    }

    if (['<', '<=', '>', '>='].includes(expr.op)) return BOOL;
    return left;
  }

  private checkCall(expr: Extract<Expr, { kind: 'call' }>, scope: Scope, expected?: Type): Type {
    if (expr.callee.kind === 'member') {
      /*
       * `audio.play(…)` is a capability call, resolved through the registry.
       *
       * Checked before the conversions and the enum constructors because a namespace is bound by an
       * import and therefore cannot collide with either: a module's last segment is lower-case by
       * convention and a primitive is a keyword.
       */
      const owner = expr.callee.target;
      if (owner.kind === 'ident' && scope.lookup(owner.name) === undefined) {
        const namespace = this.namespaces.get(owner.name);
        if (namespace !== undefined) {
          return this.checkCapabilityCall(namespace, expr.callee.name, expr, scope);
        }
      }
    }

    if (expr.callee.kind === 'member') {
      /*
       * `u8.checked(v)`, `u8.clamp(v)`, `u8.wrap(v)` — the three spellings a narrowing gets.
       *
       * Three because there are three different intents and the compiler should not guess which
       * one a narrowing meant: fail, pin to the range, or take the low bits. A language with one
       * spelling has chosen for you, in the direction people forget to check.
       */
      const owner = expr.callee.target;
      if (owner.kind === 'ident' && isPrimitive(owner.name) && scope.lookup(owner.name) === undefined) {
        return this.checkConversion(owner.name, expr.callee.name, expr, scope);
      }
    }

    if (expr.callee.kind === 'member') {
      /* `Shape.Circle(3)` constructs a payload variant. Checked here rather than through the member
         path because a constructor is not a value: there is no type for "the function
         `Shape.Circle`", only for the result of calling it. */
      const owner = expr.callee.target;
      if (owner.kind === 'ident' && scope.lookup(owner.name) === undefined) {
        const declared = this.lookupEnum(owner.name);
        if (declared !== undefined && declared.kind === 'enum') {
          return this.checkVariantCall(declared, expr.callee.name, expr, scope);
        }
      }
    }

    if (expr.callee.kind !== 'ident') {
      this.checkExpr(expr.callee, scope);
      this.report('DS0260', 'only a named function can be called', expr.callee.span);
      return ERROR;
    }

    const name = expr.callee.name;

    if (name === 'Ok' || name === 'Err' || name === 'some') {
      return this.checkBuiltinConstructor(name, expr, scope, expected);
    }

    const signature = this.lookupFn(name);
    if (signature === undefined) {
      if (scope.lookup(name) !== undefined) {
        this.report('DS0261', `\`${name}\` is a value, not a function`, expr.callee.span);
      } else {
        this.report('DS0205', `\`${name}\` is not defined`, expr.callee.span);
      }
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return ERROR;
    }

    if (expr.args.length !== signature.params.length) {
      this.report(
        'DS0262',
        `\`${name}\` takes ${signature.params.length} argument` +
          `${signature.params.length === 1 ? '' : 's'} but ${expr.args.length} ` +
          `${expr.args.length === 1 ? 'was' : 'were'} given`,
        expr.span,
      );
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return signature.returns;
    }

    expr.args.forEach((arg, index) => {
      const parameter = signature.params[index];
      const actual = this.checkExpr(arg, scope, parameter.type);
      if (!assignable(actual, parameter.type)) {
        this.report(
          'DS0263',
          `\`${name}\` expects \`${nameOf(parameter.type)}\` for \`${parameter.name}\` but this ` +
            `is \`${nameOf(actual)}\``,
          arg.span,
        );
      }
    });

    return signature.returns;
  }

  /**
   * A conversion to another numeric type: three spellings for an integer, one for a float.
   *
   * **`checked` yields an option rather than a `Result`**, and that is a decision worth its line.
   * There is exactly one way a conversion fails — the value does not fit — so an error type would
   * carry no information a reader could act on, and inventing one would put a name in the standard
   * library that every consumer then has to match against. `?` propagates an option just as it
   * propagates a failure, so `u8.checked(v)?` reads the way the design writes it.
   *
   * **A float gets one spelling, `nearest`, and the asymmetry is the point.** An integer narrowing
   * has three intents the compiler must not choose between — fail, pin, take the low bits — because
   * each is right somewhere and the wrong one is silent. A float conversion has one: IEEE rounds to
   * the nearest representable value, in both directions, and there is no second thing a caller
   * could have meant. Three names here would be two lies.
   *
   * So `nearest` covers the widening as honestly as the narrowing. `f32.nearest(x)` on an `f64`
   * rounds and loses precision; `f64.nearest(x)` on an `f32` is exact, because every `f32` value is
   * an `f64` value and the nearest one is itself. It still has to be written: `LANGUAGE.md` promises
   * there is no implicit widening, and a promise with an exception for the lossless direction is one
   * a reader has to keep a list for.
   *
   * **Added in 1.5.0, and the hole it closes was reported rather than predicted.** `std/math` is
   * single precision and a generic ECS accessor is double, so a script that read a component field
   * and wanted its square root could not say so — and `DS0232` told it, in words, that no
   * conversion existed.
   */
  private checkConversion(
    target: string,
    method: string,
    expr: Extract<Expr, { kind: 'call' }>,
    scope: Scope,
  ): Type {
    const to = primitive(target);
    const isInteger = INTEGERS.has(target);
    const isFloatTarget = FLOATS.has(target);

    if (!isInteger && !isFloatTarget) {
      this.report(
        'DS0232',
        `\`${target}\` has no conversions; \`checked\`, \`clamp\` and \`wrap\` are for ` +
          'integers and `nearest` is for floats',
        expr.span,
      );
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return ERROR;
    }

    const allowed = isInteger ? ['checked', 'clamp', 'wrap'] : ['nearest'];
    if (!allowed.includes(method)) {
      /*
       * One code for both, because it is one mistake: a conversion this type does not have.
       *
       * Splitting it by target would give a consumer two codes to grep for the same sentence, which
       * `annotations.ts` already declines to do for the same reason.
       */
      this.report(
        'DS0233',
        isInteger
          ? `\`${target}\` has \`checked\`, \`clamp\` and \`wrap\`, not \`${method}\``
          : `\`${target}\` has \`nearest\`, not \`${method}\`. A float rounds to the nearest ` +
              'value it can hold and neither wraps nor saturates.',
        expr.span,
      );
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return ERROR;
    }

    if (expr.args.length !== 1) {
      this.report('DS0262', `\`${target}.${method}\` takes exactly one value`, expr.span);
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return method === 'checked' ? option(to) : to;
    }

    const from = this.checkExpr(expr.args[0], scope);
    if (from.kind !== 'error' && !isNumeric(from)) {
      this.report(
        'DS0234',
        `\`${target}.${method}\` converts a number but this is \`${nameOf(from)}\``,
        expr.args[0].span,
      );
      return ERROR;
    }

    /* `nearest` cannot fail — every number has a nearest `f32` and a nearest `f64`, including the
       infinities a value too large to represent rounds to. Only `checked` yields an option. */
    return method === 'checked' ? option(to) : to;
  }

  /**
   * A call into a host capability.
   *
   * **When no registry is configured the call is accepted and typed `error`**, which propagates as
   * "unknown" without reporting. That is the language-server and first-look path again: a file open
   * with no host described should show its syntax and type errors, not a page of complaints about
   * capabilities nobody told the compiler about.
   */
  private checkCapabilityCall(
    namespace: { module: string; names: ReadonlySet<string> },
    member: string,
    expr: Extract<Expr, { kind: 'call' }>,
    scope: Scope,
  ): Type {
    if (this.registry === undefined) {
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return ERROR;
    }

    if (!namespace.names.has(member)) {
      this.report(
        'DS0235',
        `\`${member}\` is not imported from \`${namespace.module}\`; add it to the import list`,
        expr.callee.span,
      );
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return ERROR;
    }

    this.usedCapabilities.add(`${namespace.module}.${member}`);

    const definition = this.registry.get(namespace.module, member);
    if (definition === undefined) {
      this.report(
        'DS0236',
        `\`${namespace.module}\` has no capability \`${member}\``,
        expr.callee.span,
      );
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return ERROR;
    }

    if (expr.args.length !== definition.params.length) {
      this.report(
        'DS0262',
        `\`${namespace.module}.${member}\` takes ${definition.params.length} argument` +
          `${definition.params.length === 1 ? '' : 's'} but ${expr.args.length} ` +
          `${expr.args.length === 1 ? 'was' : 'were'} given`,
        expr.span,
      );
      for (const arg of expr.args) this.checkExpr(arg, scope);
      /* The width cannot be resolved from a call whose arity is already wrong, so a `float` return
         falls to the default rather than reporting a second, derived complaint. */
      return definition.returns === FLOAT
        ? primitive('f32')
        : this.resolveTypeName(definition.returns, expr.span);
    }

    /*
     * A `float` signature is checked in two passes, because its width belongs to the *call*.
     *
     * `math.clamp(v, 0, 1)` has to work when `v` is an `f64`, and the two literals cannot decide
     * that for themselves — a bare number has no width until something gives it one, which is
     * already how `let n: u8 = 3` avoids being a conversion error. So the arguments that *do* carry
     * a width go first and the first float among them fixes the call; the literals are held back and
     * checked afterwards against what was fixed. One pass in source order would have made
     * `math.lerp(0, 1, t)` on an `f64` `t` a mismatch over the literal `0`, which points at the
     * wrong argument and reads as nonsense.
     *
     * **Every argument is still checked exactly once**, which is the property that matters: checking
     * one twice would report its errors twice, and the deferred set is literals, which report
     * nothing.
     *
     * A signature with no `float` in it pays nothing for any of this. The first pass defers no
     * argument, so the second finds `actuals` already full and the third returns at its first line.
     */
    const actuals: (Type | undefined)[] = new Array<Type | undefined>(expr.args.length);
    let width: string | null = null;

    expr.args.forEach((arg, index) => {
      const parameter = definition.params[index];
      if (parameter.type === FLOAT) {
        if (takesWidthFromContext(arg)) return;
        const actual = this.checkExpr(arg, scope);
        actuals[index] = actual;
        if (width === null && isFloat(actual)) width = actual.name;
        return;
      }
      const declared = this.resolveTypeName(parameter.type, arg.span);
      const actual = this.checkExpr(arg, scope, declared);
      actuals[index] = actual;
      if (!assignable(actual, declared)) {
        this.report(
          'DS0263',
          `\`${namespace.module}.${member}\` expects \`${nameOf(declared)}\` for ` +
            `\`${parameter.name}\` but this is \`${nameOf(actual)}\``,
          arg.span,
        );
      }
    });

    /* Nothing fixed it, so the call is single precision — the width a bare literal takes and
       therefore the width every script that predates this rule already meant. */
    const fixed: boolean = width !== null;
    const resolved = primitive(width ?? 'f32');

    expr.args.forEach((arg, index) => {
      if (actuals[index] === undefined) actuals[index] = this.checkExpr(arg, scope, resolved);
    });

    expr.args.forEach((arg, index) => {
      if (definition.params[index].type !== FLOAT) return;
      const actual = actuals[index] as Type;
      if (assignable(actual, resolved)) return;
      /*
       * Two shapes of wrongness, and they deserve different sentences.
       *
       * A float of the other width is a conversion the caller can write, so the message names it —
       * this is the case the whole feature exists for, and a diagnostic that stopped at "expects
       * f64" would leave the reader where `DS0232` used to leave them. Anything else is not a float
       * at all, and when no argument fixed the width the honest thing is to say both are welcome.
       */
      const wanted = fixed || isFloat(actual) ? `\`${nameOf(resolved)}\`` : '`f32` or `f64`';
      const hint = isFloat(actual)
        ? `. Convert it with \`${nameOf(resolved)}.nearest(…)\``
        : '';
      this.report(
        'DS0263',
        `\`${namespace.module}.${member}\` expects ${wanted} for ` +
          `\`${definition.params[index].name}\` but this is \`${nameOf(actual)}\`${hint}`,
        arg.span,
      );
    });

    if (definition.returns !== FLOAT) return this.resolveTypeName(definition.returns, expr.span);

    /* Single precision is rounded at the call rather than by the host — see `CheckResult.rounded`
       for why the implementation computes in double and this is where it narrows. */
    if (resolved.kind === 'primitive' && resolved.name === 'f32') this.rounded.add(expr);
    return resolved;
  }

  /**
   * A type named by a capability definition, resolved the way a written annotation would be.
   *
   * A trailing `?` is honoured so a definition can say a lookup may find nothing — which the audio
   * surface needs, since a sound slot resolves through several format candidates and the file often
   * is not there.
   */
  private resolveTypeName(name: string, span: Span): Type {
    if (name === 'void') return VOID;
    if (name.endsWith('?')) return option(this.resolveTypeName(name.slice(0, -1), span));
    /* Through `primitiveType`, so a capability naming `Entity` gets the handle kind that a written
       annotation gets. These two paths disagreed until 1.6.0; see `primitiveType`. */
    if (isPrimitive(name)) return primitiveType(name);

    const declared = this.lookupData(name) ?? this.lookupEnum(name);
    if (declared !== undefined) return declared;

    const opaque = this.registry?.getType(name);
    if (opaque !== undefined) return { kind: 'data', name, fields: new Map() };

    this.report('DS0237', `\`${name}\` is not a type this host registered`, span);
    return ERROR;
  }

  private checkVariantCall(
    declared: Type & { kind: 'enum' },
    variant: string,
    expr: Extract<Expr, { kind: 'call' }>,
    scope: Scope,
  ): Type {
    const payload = declared.variants.get(variant);
    if (payload === undefined) {
      this.report('DS0216', `\`${declared.name}\` has no variant \`${variant}\``, expr.span);
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return ERROR;
    }
    if (payload === null) {
      this.report(
        'DS0220',
        `\`${declared.name}.${variant}\` carries no value, so it is not called: write ` +
          `\`${declared.name}.${variant}\``,
        expr.span,
      );
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return declared;
    }
    if (expr.args.length !== 1) {
      this.report('DS0262', `\`${declared.name}.${variant}\` takes exactly one value`, expr.span);
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return declared;
    }
    const actual = this.checkExpr(expr.args[0], scope, payload);
    if (!assignable(actual, payload)) {
      this.report(
        'DS0227',
        `\`${declared.name}.${variant}\` expects \`${nameOf(payload)}\` but this is ` +
          `\`${nameOf(actual)}\``,
        expr.args[0].span,
      );
    }
    return declared;
  }

  private checkBuiltinConstructor(
    name: 'Ok' | 'Err' | 'some',
    expr: Extract<Expr, { kind: 'call' }>,
    scope: Scope,
    expected?: Type,
  ): Type {
    if (expr.args.length !== 1) {
      this.report('DS0262', `\`${name}\` takes exactly one argument`, expr.span);
      for (const arg of expr.args) this.checkExpr(arg, scope);
      return ERROR;
    }

    if (name === 'some') {
      const inner = this.checkExpr(
        expr.args[0],
        scope,
        expected?.kind === 'option' ? expected.inner : undefined,
      );
      return inner.kind === 'error' ? ERROR : option(inner);
    }

    /*
     * `Ok(v)` and `Err(e)` need the *other* half of the result from context.
     *
     * `Ok(3)` alone is a `Result<f32, ?>` and the error type is unknowable from the expression, so
     * the expectation supplies it. Without one this reports rather than inventing a type — a
     * made-up error half would make two results that should differ compare as the same.
     */
    if (expected?.kind !== 'result') {
      this.report(
        'DS0226',
        `\`${name}\` needs a \`Result\` type from its context — annotate the binding or the ` +
          "function's return type",
        expr.span,
      );
      this.checkExpr(expr.args[0], scope);
      return ERROR;
    }

    const half = name === 'Ok' ? expected.ok : expected.err;
    const actual = this.checkExpr(expr.args[0], scope, half);
    if (!assignable(actual, half)) {
      this.report(
        'DS0227',
        `\`${name}\` expects \`${nameOf(half)}\` but this is \`${nameOf(actual)}\``,
        expr.args[0].span,
      );
    }
    return expected;
  }

  private checkRecord(expr: Extract<Expr, { kind: 'record' }>, scope: Scope): Type {
    const declared = this.lookupData(expr.name);
    if (declared === undefined || declared.kind !== 'data') {
      this.report('DS0204', `\`${expr.name}\` is not a record this module declares`, expr.span);
      for (const field of expr.fields) this.checkExpr(field.value, scope);
      return ERROR;
    }

    const seen = new Set<string>();
    for (const field of expr.fields) {
      const type = declared.fields.get(field.name);
      if (type === undefined) {
        this.report('DS0203', `\`${expr.name}\` has no field \`${field.name}\``, field.span);
        this.checkExpr(field.value, scope);
        continue;
      }
      if (seen.has(field.name)) {
        this.report('DS0207', `\`${field.name}\` is given more than once`, field.span);
      }
      seen.add(field.name);
      const actual = this.checkExpr(field.value, scope, type);
      if (!assignable(actual, type)) {
        this.report(
          'DS0208',
          `\`${field.name}\` is \`${nameOf(type)}\` but this is \`${nameOf(actual)}\``,
          field.value.span,
        );
      }
    }

    /*
     * Every field must be given a value.
     *
     * Silently filling the rest from declared defaults would be tempting and is refused: a record
     * literal that looks complete while half of it came from somewhere else is the same ambiguity
     * as an implicit null, one level up. Defaults exist for `create…()`, which is a different
     * operation with a different name.
     */
    for (const [name] of declared.fields) {
      if (seen.has(name)) continue;
      this.report('DS0228', `\`${expr.name}\` needs a value for \`${name}\``, expr.span);
    }

    return declared;
  }

  private checkTry(expr: Extract<Expr, { kind: 'try' }>, scope: Scope): Type {
    const inner = this.checkExpr(expr.inner, scope);
    if (inner.kind === 'error') return ERROR;

    if (inner.kind === 'result') {
      if (this.returns.kind !== 'result') {
        this.report(
          'DS0211',
          '`?` propagates a failure, so the enclosing function must return a `Result`',
          expr.span,
        );
        return ERROR;
      }
      if (!assignable(inner.err, this.returns.err)) {
        this.report(
          'DS0212',
          `\`?\` would propagate \`${nameOf(inner.err)}\` but this function returns ` +
            `\`${nameOf(this.returns.err)}\``,
          expr.span,
        );
        return ERROR;
      }
      return inner.ok;
    }

    if (inner.kind === 'option') {
      if (this.returns.kind !== 'option') {
        this.report(
          'DS0211',
          '`?` propagates an absent value, so the enclosing function must return an option',
          expr.span,
        );
        return ERROR;
      }
      return inner.inner;
    }

    this.report(
      'DS0213',
      `\`?\` needs a \`Result\` or an option but this is \`${nameOf(inner)}\``,
      expr.span,
    );
    return ERROR;
  }

  private checkMatch(
    expr: Extract<Expr, { kind: 'match' }>,
    scope: Scope,
    expected?: Type,
  ): Type {
    const subject = this.checkExpr(expr.subject, scope);

    if (expr.arms.length === 0) {
      this.report('DS0214', 'a `match` needs at least one arm', expr.span);
      return ERROR;
    }

    const covered = new Set<string>();
    let sawWildcard = false;
    let armType: Type | undefined;

    for (const arm of expr.arms) {
      const armScope = scope.child();
      this.bindPattern(arm.pattern, subject, armScope, covered);
      if (arm.pattern.kind === 'wildcard') sawWildcard = true;

      const body = this.checkExpr(arm.body, armScope, expected ?? armType);
      if (body.kind === 'error') continue;
      if (armType === undefined) {
        armType = body;
      } else if (!same(armType, body)) {
        this.report(
          'DS0215',
          `every arm of a \`match\` must have the same type, but this is \`${nameOf(body)}\` ` +
            `where the first was \`${nameOf(armType)}\``,
          arm.body.span,
        );
      }
    }

    if (!sawWildcard) this.checkExhaustive(subject, covered, expr.span);
    return armType ?? ERROR;
  }

  private bindPattern(pattern: Pattern, subject: Type, scope: Scope, covered: Set<string>): void {
    if (pattern.kind === 'wildcard') return;

    covered.add(pattern.name);

    const payload = this.payloadOf(subject, pattern.name, pattern.span);
    if (pattern.binding === undefined) return;
    scope.declare(pattern.binding, { type: payload ?? ERROR, mutable: false });
  }

  /** The type a variant carries, or `null` when it carries nothing. Reports an unknown variant. */
  private payloadOf(subject: Type, variant: string, span: Span): Type | null {
    if (subject.kind === 'error') return ERROR;

    if (subject.kind === 'result') {
      if (variant === 'Ok') return subject.ok;
      if (variant === 'Err') return subject.err;
      this.report('DS0216', `a \`Result\` has \`Ok\` and \`Err\`, not \`${variant}\``, span);
      return ERROR;
    }

    if (subject.kind === 'option') {
      if (variant === 'some') return subject.inner;
      if (variant === 'none') return null;
      this.report('DS0216', `an option has \`some\` and \`none\`, not \`${variant}\``, span);
      return ERROR;
    }

    if (subject.kind === 'enum') {
      const declared = subject.variants.get(variant);
      if (declared === undefined) {
        this.report('DS0216', `\`${subject.name}\` has no variant \`${variant}\``, span);
        return ERROR;
      }
      return declared;
    }

    this.report(
      'DS0217',
      `\`match\` needs an enum, a \`Result\` or an option, but this is \`${nameOf(subject)}\``,
      span,
    );
    return ERROR;
  }

  /**
   * Every variant is covered, and the diagnostic names the ones that are not.
   *
   * Naming them is the whole value. "Not exhaustive" sends a reader back to the declaration to work
   * out which case they forgot; naming the variant is the answer they were going to look up.
   */
  private checkExhaustive(subject: Type, covered: ReadonlySet<string>, span: Span): void {
    const required =
      subject.kind === 'result'
        ? ['Ok', 'Err']
        : subject.kind === 'option'
          ? ['some', 'none']
          : subject.kind === 'enum'
            ? [...subject.variants.keys()]
            : null;

    if (required === null) return;

    const missing = required.filter((variant) => !covered.has(variant));
    if (missing.length === 0) return;

    this.report(
      'DS0210',
      `this \`match\` does not cover ${missing.map((m) => `\`${m}\``).join(' or ')}`,
      span,
    );
  }

  private resolveTypeRef(ref: TypeRef): Type {
    if (ref.kind === 'option') return option(this.resolveTypeRef(ref.inner));

    /*
     * `Entity` is lexed as a primitive type name and is not a `primitive` Type.
     *
     * It is a kind of its own so `e.Health` is legal on a handle and not on every number — see the
     * `entity` kind. It is spelled here because a script has to be able to *write* the type: a
     * component field holding another entity is the design's own first example, and a helper taking
     * a handle cannot exist without a name for one.
     */
    if (ref.kind === 'primitive' && isPrimitive(ref.name)) return primitiveType(ref.name);

    if (ref.name === 'Result') {
      if (ref.args.length !== 2) {
        this.report('DS0218', '`Result` takes two type arguments: a value and an error', ref.span);
        return ERROR;
      }
      return result(this.resolveTypeRef(ref.args[0]), this.resolveTypeRef(ref.args[1]));
    }

    const declared = this.lookupData(ref.name) ?? this.lookupEnum(ref.name);
    if (declared !== undefined) return declared;

    /*
     * A host's opaque type is nameable in a written annotation, not only in a capability signature.
     *
     * `fn canSee(self: Node, target: Node)` is the ordinary shape of a behaviour script — a
     * capability hands back a handle and the script passes it on. Resolving these only inside
     * signatures made that unwritable, which is exactly what the corpus was read to find. It has no
     * fields, because a field would be a promise about the host's representation that the host
     * could then never change.
     */
    const opaque = this.registry?.getType(ref.name);
    if (opaque !== undefined) return { kind: 'data', name: ref.name, fields: new Map() };

    /*
     * `World` resolves with no registry, because a query loop has to type without a host.
     *
     * A language with `component`, `system` and `query` as forms plainly knows what a world is —
     * the same argument that made `Entity` a type this language spells rather than borrows. This
     * sits **after** the registry lookup rather than before it, so a host's own declaration wins
     * and keeps its documentation; and after `lookupData`, so a consumer's own `data World` wins
     * over both. It is a fallback for the case that has no host at all: a language server open on a
     * file with no project configured, which still has to type `fn f(world: World)`.
     *
     * **What this costs** is a name the language reserves in effect without reserving it in the
     * token table. **What would make it wrong** is a second host type the language needed to know
     * about, at which point this is a table rather than a branch.
     */
    if (ref.name === 'World') return { kind: 'data', name: 'World', fields: new Map() };

    this.report('DS0204', `\`${ref.name}\` is not a type this module declares or imports`, ref.span);
    return ERROR;
  }
}

export function check(
  module: Module,
  file: string,
  registry?: CapabilityRegistry,
  imported?: ImportedScope,
): CheckResult {
  return new Checker(file, registry, imported).check(module);
}

/**
 * A module's declarations, resolved, without checking a single body.
 *
 * This is what another module needs from it and all of what another module needs: names, field
 * types and signatures. Checking bodies here would check every reachable file on every keystroke in
 * a leaf, and would report a dependency's errors against the file that imported it.
 */
export function collect(
  module: Module,
  file: string,
  imported?: ImportedScope,
): ImportedScope & {
  readonly types: ReadonlyMap<Expr, Type>;
  readonly diagnostics: readonly Diagnostic[];
} {
  return new Checker(file, undefined, imported).collect(module);
}

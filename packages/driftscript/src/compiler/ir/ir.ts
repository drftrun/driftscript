/**
 * The typed intermediate representation, and why a backend may read nothing else.
 *
 * Invariant 13: the compiler emits typed IR before any backend runs, and invariant 12 says
 * JavaScript ESM is the first backend rather than the semantic definition. Those two together are
 * one rule with a consequence: **a backend that read the syntax tree would have to re-derive every
 * type**, and the evaluation of a second backend would then be an evaluation of writing the checker
 * twice.
 *
 * So every node here carries a resolved `IrType` and a `Span`. Nothing here is optional, nothing
 * here needs a symbol table to interpret, and the only thing a backend has to know is how to write
 * its own syntax.
 *
 * The cost is a third representation for a language whose first backend could have walked the tree.
 * What would make it wrong is a backend so close to the source that lowering loses information it
 * needs — which is a real risk for a *formatter*, and is exactly why the formatter reads tokens
 * rather than this.
 */
import type { EditorMeta, Span } from '../ast.ts';

export type IrType =
  | { readonly kind: 'f32' }
  | { readonly kind: 'f64' }
  | { readonly kind: 'int'; readonly name: string }
  | { readonly kind: 'bool' }
  | { readonly kind: 'string' }
  | { readonly kind: 'void' }
  /**
   * An entity handle.
   *
   * Carried rather than collapsed to `f64`, and the reason is the schema rather than the code a
   * backend writes. A component field typed `Entity` has to be **named** as one, because a scene
   * load rewrites every stored handle through its id map — a field that arrived as `f64` would be
   * serialised into a world whose indices mean something else, silently. It emits as a number,
   * which is what it is.
   */
  | { readonly kind: 'entity' }
  | { readonly kind: 'data'; readonly name: string }
  | { readonly kind: 'enum'; readonly name: string }
  | { readonly kind: 'option'; readonly inner: IrType }
  | { readonly kind: 'result'; readonly ok: IrType; readonly err: IrType };

export type IrExpr =
  | {
      readonly kind: 'const';
      readonly value: number | string | boolean;
      readonly type: IrType;
      readonly span: Span;
    }
  | { readonly kind: 'local'; readonly name: string; readonly type: IrType; readonly span: Span }
  /**
   * `e.Hunger.value` — one field of one component of an entity a query loop bound.
   *
   * **Its own node rather than two nested field accesses**, because it is not a property chain: a
   * handle has no `.Hunger` and a component is not a value. It resolves to an index into a column,
   * and the loop it belongs to is what knows which view holds that column — so the resolution is
   * carried here rather than rediscovered by a backend walking the tree looking for a shape.
   */
  | {
      readonly kind: 'componentField';
      /** Which of the enclosing loop's views: the loop's depth and the view's position in it. */
      readonly depth: number;
      readonly view: number;
      readonly field: string;
      readonly type: IrType;
      readonly span: Span;
    }
  | {
      readonly kind: 'field';
      readonly target: IrExpr;
      readonly name: string;
      readonly type: IrType;
      readonly span: Span;
    }
  /**
   * `target?.name`, lowered as its own node rather than as a conditional.
   *
   * A backend emits `?.` directly where its host language has one; one that does not emits a
   * temporary and a test. Lowering it to a conditional here would force the first kind to
   * un-lower it.
   */
  | {
      readonly kind: 'optionalField';
      readonly target: IrExpr;
      readonly name: string;
      readonly type: IrType;
      readonly span: Span;
    }
  | {
      readonly kind: 'binary';
      readonly op: string;
      readonly left: IrExpr;
      readonly right: IrExpr;
      readonly type: IrType;
      readonly span: Span;
    }
  | {
      readonly kind: 'unary';
      readonly op: string;
      readonly operand: IrExpr;
      readonly type: IrType;
      readonly span: Span;
    }
  | {
      readonly kind: 'call';
      readonly callee: string;
      readonly args: readonly IrExpr[];
      /**
       * Whether the backend must round this call's result to `f32`.
       *
       * Set only on a capability whose signature is polymorphic in its float width and whose call
       * resolved to single precision. Such a capability is implemented once, in double, so the
       * narrowing has to happen somewhere — and the call site is where this language already puts
       * it, since `a * b` on `f32` emits its own rounding rather than assuming its operands were
       * rounded for it.
       *
       * A flag rather than a node because it is a property of *this* call and not a computation: a
       * wrapper node would have to be typed, and its type is the call's type.
       */
      readonly rounds: boolean;
      readonly type: IrType;
      readonly span: Span;
    }
  | {
      readonly kind: 'record';
      readonly name: string;
      readonly fields: readonly { readonly name: string; readonly value: IrExpr }[];
      readonly type: IrType;
      readonly span: Span;
    }
  /**
   * `Ok(v)`, `Err(e)`, `some(v)` and `none`, as one node.
   *
   * A tagged value rather than four constructors, because every backend has to represent the tag
   * somehow and a shape per constructor would make each backend choose four times.
   */
  | {
      readonly kind: 'wrap';
      readonly tag: 'Ok' | 'Err' | 'some' | 'none';
      readonly value: IrExpr | null;
      readonly type: IrType;
      readonly span: Span;
    }
  | { readonly kind: 'try'; readonly inner: IrExpr; readonly type: IrType; readonly span: Span }
  | {
      readonly kind: 'match';
      readonly subject: IrExpr;
      readonly arms: readonly IrArm[];
      readonly type: IrType;
      readonly span: Span;
    };

export interface IrArm {
  /** `null` is the wildcard. */
  readonly variant: string | null;
  readonly binding: string | null;
  readonly body: IrExpr;
  readonly span: Span;
}

export type IrStmt =
  | {
      readonly kind: 'let';
      readonly name: string;
      readonly value: IrExpr;
      readonly type: IrType;
      readonly span: Span;
    }
  | { readonly kind: 'assign'; readonly target: IrExpr; readonly value: IrExpr; readonly span: Span }
  | { readonly kind: 'return'; readonly value: IrExpr | null; readonly span: Span }
  | {
      readonly kind: 'if';
      readonly condition: IrExpr;
      readonly then: readonly IrStmt[];
      readonly otherwise: readonly IrStmt[] | null;
      readonly span: Span;
    }
  | {
      readonly kind: 'ifLet';
      readonly name: string;
      readonly subject: IrExpr;
      readonly then: readonly IrStmt[];
      readonly otherwise: readonly IrStmt[] | null;
      readonly span: Span;
    }
  | {
      readonly kind: 'while';
      readonly condition: IrExpr;
      readonly body: readonly IrStmt[];
      readonly span: Span;
    }
  /**
   * `for e in query<…>() { … }`, with every component name resolved.
   *
   * **An `entity` term is expanded before it gets here**, so a backend never sees an entity name
   * and never has to know what one stands for. `required` yields the binding; `with` narrows
   * without yielding; `without` excludes.
   */
  | {
      readonly kind: 'forQuery';
      readonly binding: string;
      /**
       * How many query loops enclose this one, counting from zero.
       *
       * **Carried rather than recounted, because a `componentField` names it.** The emitter used to
       * keep its own counter alongside this one — two descriptions of one number, and they agreed
       * only by coincidence: perturbing the lowering's version left the emitter's untouched, so a
       * nested loop's field access pointed at the outer loop's view while the declarations still
       * looked right.
       */
      readonly depth: number;
      /** The identifier to pass as the world: a system's view, or a declared `World` parameter. */
      readonly world: string;
      /** Components an entity must have to be yielded, `entity` terms already expanded. */
      readonly required: readonly string[];
      /** Components an entity must not have. */
      readonly excluded: readonly string[];
      /**
       * The views to hoist when the loop opens, and whether each must be writable.
       *
       * One per component the body actually touches rather than one per required component: a loop
       * requiring four and reading one takes one view, and asking for the other three would make a
       * read-only system demand access the engine refuses.
       */
      readonly views: readonly { readonly component: string; readonly forWriting: boolean }[];
      readonly body: readonly IrStmt[];
      readonly span: Span;
    }
  /** `await fixedTime(500ms)`. The duration has already lost its unit and is seconds. */
  | {
      readonly kind: 'await';
      readonly clock: 'fixed' | 'frame' | 'wall';
      readonly duration: IrExpr;
      readonly span: Span;
    }
  /**
   * Who owns a task a `spawn` starts, resolved lexically while lowering.
   *
   * Resolved here rather than in a backend because it is a fact about the *source* — which block
   * the statement is written inside — and a backend that had to work it out again would be a second
   * place the rule lived.
   */
  | { readonly kind: 'spawn'; readonly task: string; readonly owner: IrOwner; readonly args: readonly IrExpr[]; readonly span: Span }
  | {
      readonly kind: 'scope';
      readonly name: string;
      readonly parent: IrOwner;
      readonly body: readonly IrStmt[];
      readonly span: Span;
    }
  /**
   * `become Opening`.
   *
   * `inEntry` records which of the two shapes the machine reaches through: an entry block is a
   * task and carries it on its frame, while an `on` handler is a plain function and takes it as a
   * parameter. Resolved while lowering, because it is a fact about where the statement was written.
   */
  | { readonly kind: 'become'; readonly state: string; readonly inEntry: boolean; readonly span: Span }
  /** `await settle()` — start a task and suspend until it is done. */
  | {
      readonly kind: 'awaitTask';
      readonly task: string;
      readonly owner: IrOwner;
      readonly args: readonly IrExpr[];
      readonly span: Span;
    }
  /** `emit Alarm { … }`. The payload's fields are in declaration order, defaults already filled. */
  | {
      readonly kind: 'emit';
      readonly event: string;
      readonly fields: readonly { readonly name: string; readonly value: IrExpr }[];
      readonly span: Span;
    }
  | { readonly kind: 'expr'; readonly expr: IrExpr; readonly span: Span };

/** What a spawned task, or a nested scope, belongs to. */
export type IrOwner =
  /** The module's own scope: a `spawn` written in an ordinary function. */
  | { readonly kind: 'module' }
  /** The running task's own scope, so a child dies with the task that started it. */
  | { readonly kind: 'task' }
  /** A `scope` block written around the statement. */
  | { readonly kind: 'scope'; readonly name: string };

export interface IrField {
  readonly name: string;
  readonly type: IrType;
  readonly init: IrExpr;
  /**
   * `<module>::<Record>` — where this field was **declared**, which is not always where it appears.
   *
   * A subtype splices its base's lowered fields, and those keep the owner they were lowered with.
   * That is what makes a field id stable when a base grows: the subtype's own fields are unmoved
   * and the new one arrives with an id belonging to the base.
   */
  readonly owner: string;
  /** The name `@id(…)` pinned, if the author pinned one. See `runtime/state.ts`. */
  readonly pinned?: string;
}

export interface IrData {
  readonly name: string;
  readonly fields: readonly IrField[];
  readonly span: Span;
}

/**
 * A component type this module declares, or asserts about its host.
 *
 * **Shaped like `IrData` on purpose**, so `schemaOf` builds a component's schema with the same code
 * that builds a record's — one description of what a field id is, rather than two that agree until
 * one moves.
 */
export interface IrComponent {
  readonly name: string;
  /** `component X from host { … }` — the host registered it; this asserts its shape at bind. */
  readonly fromHost: boolean;
  readonly fields: readonly IrField[];
  /** Per-field editor metadata, by field name. Absent in a production build — see the emitter. */
  readonly editor: Readonly<Record<string, EditorMeta>>;
  readonly span: Span;
}

/**
 * An entity: the components it requires, and the implicit component its own fields became.
 *
 * The implicit component is in `components` like any other; this names it so a host can tell the
 * two apart when it reports what a world holds.
 */
export interface IrEntity {
  readonly name: string;
  readonly requires: readonly string[];
  readonly ownComponent: string | null;
  readonly span: Span;
}

/**
 * A system: the function the host registers, and everything the schedule needs to place it.
 *
 * `reads` and `writes` are the **inferred** sets rather than whatever the author declared, because
 * the declaration is an assertion and the engine needs the truth. A system declaring nothing is
 * fully described here all the same.
 */
export interface IrSystem {
  readonly name: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly after: readonly string[];
  readonly everyTicks: number;
  readonly body: readonly IrStmt[];
  readonly span: Span;
}

/** A prefab: components and the constant values to write into them. */
export interface IrPrefab {
  readonly name: string;
  readonly components: readonly {
    readonly name: string;
    readonly values: Readonly<Record<string, number | string | boolean>>;
  }[];
  readonly span: Span;
}

export interface IrEnum {
  readonly name: string;
  readonly variants: readonly { readonly name: string; readonly hasPayload: boolean }[];
  readonly span: Span;
}

export interface IrFn {
  readonly name: string;
  readonly annotations: readonly string[];
  readonly params: readonly { readonly name: string; readonly type: IrType }[];
  readonly returns: IrType;
  readonly body: readonly IrStmt[];
  readonly span: Span;
}

/**
 * A task, which differs from an `IrFn` in the only two ways that reach the backend: it returns
 * nothing, and its body may suspend. The emitter turns it into a state machine rather than a
 * function, so keeping it a separate list is what stops a backend having to ask.
 */
export interface IrTask {
  readonly name: string;
  readonly annotations: readonly string[];
  readonly params: readonly { readonly name: string; readonly type: IrType }[];
  readonly body: readonly IrStmt[];
  readonly span: Span;
}

/**
 * An event declaration.
 *
 * It emits no code: an event is a name and a shape, and the shape is built at each `emit`. It
 * reaches the IR anyway because lowering an `emit` needs the field order and the defaults, and a
 * backend that had to go back to the AST for those would be a backend reading two representations.
 */
export interface IrEvent {
  readonly name: string;
  readonly fields: readonly IrField[];
  readonly span: Span;
}

/** A module-level `on` handler, named so registration does not allocate a closure. */
export interface IrHandler {
  /** The generated function's name, unique within the module. */
  readonly name: string;
  readonly event: string;
  readonly binding: string;
  readonly body: readonly IrStmt[];
  readonly span: Span;
}

/** One state of the module's machine. */
export interface IrState {
  readonly name: string;
  /** The entry block as a task, or `null`. Named so a reader of the output can find it. */
  readonly enter: IrTask | null;
  readonly handlers: readonly {
    readonly event: string;
    /** The payload's name, or `null` where the state does not read it. */
    readonly binding: string | null;
    readonly body: readonly IrStmt[];
  }[];
  readonly span: Span;
}

/** A host namespace a module calls into: `audio` bound to `drift/audio`. */
export interface IrNamespace {
  readonly alias: string;
  readonly module: string;
}

export interface IrModule {
  readonly namespaces: readonly IrNamespace[];
  readonly data: readonly IrData[];
  readonly components: readonly IrComponent[];
  readonly entities: readonly IrEntity[];
  readonly systems: readonly IrSystem[];
  readonly prefabs: readonly IrPrefab[];
  readonly enums: readonly IrEnum[];
  readonly fns: readonly IrFn[];
  readonly tasks: readonly IrTask[];
  readonly events: readonly IrEvent[];
  readonly handlers: readonly IrHandler[];
  readonly states: readonly IrState[];
  /**
   * The logical modules this source imported, in source order.
   *
   * This is what the linker checks against a target manifest, and what `driftscript capabilities`
   * reports. It carries module names rather than the individual capabilities used, because a target
   * provides or withholds a whole module — a manifest listing individual functions would be a
   * manifest that goes stale every time a module grows one.
   */
  readonly requires: readonly string[];
  /**
   * The `.drs` files this module was compiled against, in source order.
   *
   * **Separate from `requires`, because they are different things.** A file is source this module
   * was checked against; a requirement is a capability a host must provide. The linker reads only
   * the second, and a bundler reads only the first — which is what stops a relative import being
   * refused as a capability no target provides.
   */
  readonly imports: readonly IrImport[];
}

export interface IrImport {
  /** The specifier as written, without an extension. */
  readonly module: string;
  /**
   * The imported names that exist at runtime: enums and functions.
   *
   * **A record is not among them, and that is not an omission.** A record emits `createDog`, never
   * `Dog`, so importing the name a script wrote would name an export that does not exist and the
   * module would fail to load. Record literals emit inline, so nothing is needed at runtime for a
   * type at all.
   */
  readonly values: readonly string[];
}

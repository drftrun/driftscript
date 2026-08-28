/**
 * The syntax tree, and what it deliberately does not carry.
 *
 * Nodes carry a `Span` and nothing resolved. Types, effects and capability requirements are the
 * checker's, and a tree that carried them would have two places where a type could be written and
 * one of them would be wrong. The IR is where resolved information lives, which is the invariant
 * that lets a second backend exist at all.
 *
 * The cost is a third representation — tokens, tree, IR — for a language whose first backend could
 * have been written straight off the tree. What would make that wrong is exactly the plan: a
 * JavaScript backend that read this would have re-derived every type, and the evaluation of a
 * second backend would then be an evaluation of writing the checker twice.
 */

/** A half-open range of byte offsets into the source. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * A type as it is written, before anything resolves it.
 *
 * `args` is what makes `Result<Resource, LoadError>` expressible. It is on both shapes rather than
 * only on `named` because a future primitive could take one — and because a parser that had to
 * decide which shape a generic was before resolving it would be resolving.
 */
export type TypeRef =
  | {
      readonly kind: 'primitive';
      readonly name: string;
      readonly args: readonly TypeRef[];
      readonly span: Span;
    }
  | {
      readonly kind: 'named';
      readonly name: string;
      readonly args: readonly TypeRef[];
      readonly span: Span;
    }
  /** `T?`, which is `Option<T>` with a spelling that keeps the common case short. */
  | { readonly kind: 'option'; readonly inner: TypeRef; readonly span: Span };

export type Expr =
  | { readonly kind: 'number'; readonly value: number; readonly unit?: string; readonly span: Span }
  | { readonly kind: 'string'; readonly value: string; readonly span: Span }
  | { readonly kind: 'bool'; readonly value: boolean; readonly span: Span }
  | { readonly kind: 'ident'; readonly name: string; readonly span: Span }
  | { readonly kind: 'member'; readonly target: Expr; readonly name: string; readonly span: Span }
  /**
   * `target?.name`, which the checker treats as producing an option.
   *
   * A distinct node rather than a flag on `member`, because the checker has to know that the
   * operation *may not have run* — and a flag is the kind of thing a later pass reads past.
   */
  | {
      readonly kind: 'optionalMember';
      readonly target: Expr;
      readonly name: string;
      readonly span: Span;
    }
  | {
      readonly kind: 'binary';
      readonly op: string;
      readonly left: Expr;
      readonly right: Expr;
      readonly span: Span;
    }
  | { readonly kind: 'unary'; readonly op: string; readonly operand: Expr; readonly span: Span }
  | {
      readonly kind: 'call';
      readonly callee: Expr;
      readonly args: readonly Expr[];
      readonly span: Span;
    }
  /** A record literal: `PulseState { phase: 0 }`. */
  | {
      readonly kind: 'record';
      readonly name: string;
      readonly fields: readonly { readonly name: string; readonly value: Expr; readonly span: Span }[];
      readonly span: Span;
    }
  /** `expr?` — propagate an `Err` or a `None` to the caller. */
  /** `[a, b, c]` — a list literal. Empty needs a type from its context, like `none` does. */
  | { readonly kind: 'listLiteral'; readonly items: readonly Expr[]; readonly span: Span }
  /**
   * `xs[i]` — the one indexing form.
   *
   * A postfix like a call rather than a method, because `xs.at(i)` would be the language's only
   * method and would need a receiver rule nothing else has.
   */
  | { readonly kind: 'index'; readonly target: Expr; readonly at: Expr; readonly span: Span }
  | { readonly kind: 'try'; readonly inner: Expr; readonly span: Span }
  | {
      readonly kind: 'match';
      readonly subject: Expr;
      readonly arms: readonly MatchArm[];
      readonly span: Span;
    };

export interface MatchArm {
  readonly pattern: Pattern;
  readonly body: Expr;
  readonly span: Span;
}

/**
 * A pattern, which is deliberately shallow.
 *
 * A variant name, an optional binding for its payload, and `_`. Nested destructuring is not here:
 * it multiplies the exhaustiveness checker's work and every corpus file so far reads better with a
 * second `match` than with a nested pattern. What would make that wrong is a corpus file that
 * cannot be written without one.
 */
export type Pattern =
  | {
      readonly kind: 'variant';
      readonly name: string;
      readonly binding?: string;
      readonly span: Span;
    }
  | { readonly kind: 'wildcard'; readonly span: Span };

/**
 * `query<A, B>().with<C>().without<D>()` — the subject of a `for … in`, and nothing else.
 *
 * **A query is not a value.** It appears here and in no other position, which is what lets the
 * parser read `<` as type arguments without knowing what the receiver is — and what makes the
 * entity model's rule structural rather than documented: a query result may not outlive the loop
 * it was made in, and a query that cannot be bound to anything cannot outlive anything.
 *
 * `required` yields the binding; `with` narrows without yielding; `without` excludes. An `entity`
 * name is legal in `required` and expands to the components it stands for, which is why these are
 * `TypeRef` rather than resolved names — the expansion is the checker's.
 */
export interface QuerySpec {
  readonly required: readonly TypeRef[];
  readonly with: readonly TypeRef[];
  readonly without: readonly TypeRef[];
  readonly span: Span;
}

export type Stmt =
  | {
      readonly kind: 'let';
      readonly name: string;
      readonly mutable: boolean;
      readonly type?: TypeRef;
      readonly value: Expr;
      readonly span: Span;
    }
  | { readonly kind: 'assign'; readonly target: Expr; readonly value: Expr; readonly span: Span }
  /**
   * `for e in query<…>() { … }` — the language's first loop over anything.
   *
   * `while` was the only loop before this, and `for` and `in` had been reserved words with no form
   * at all. The binding names an entity handle; the body reaches its components through it.
   */
  | {
      readonly kind: 'forQuery';
      readonly binding: string;
      readonly query: QuerySpec;
      readonly body: readonly Stmt[];
      readonly span: Span;
    }
  /**
   * `for item in xs { … }` — a walk over a list.
   *
   * Kept apart from `forQuery` rather than folded into one node with a subject, because the two
   * share a keyword and nothing else: a query loop resolves components, plans views, and may not
   * suspend; this one binds a value and has none of that. One node carrying both would be a node
   * every reader has to check the shape of.
   */
  | {
      readonly kind: 'forList';
      readonly binding: string;
      readonly subject: Expr;
      readonly body: readonly Stmt[];
      readonly span: Span;
    }
  | {
      readonly kind: 'compoundAssign';
      readonly target: Expr;
      readonly op: string;
      readonly value: Expr;
      readonly span: Span;
    }
  | { readonly kind: 'return'; readonly value?: Expr; readonly span: Span }
  /**
   * `break` and `continue`, which leave a loop or skip to its next turn.
   *
   * Both words were reserved from the first lexer and had no form for as long as the language had
   * only `while`. What made them worth building is `for … in query`: a consumer reported writing one
   * more `else` for every case that would have been skipped, and inside a query loop nested in an
   * `update` the indentation is what a reader is fighting.
   *
   * One node with a `word` rather than two kinds, because everything downstream treats them as the
   * same thing — a jump out of the innermost enclosing loop — and differs only in where it jumps to.
   */
  | { readonly kind: 'loopJump'; readonly word: 'break' | 'continue'; readonly span: Span }
  | {
      readonly kind: 'if';
      readonly condition: Expr;
      readonly then: readonly Stmt[];
      readonly otherwise?: readonly Stmt[];
      readonly span: Span;
    }
  /** `if let name = optionExpr { … }` — the only way to read an option's contents. */
  | {
      readonly kind: 'ifLet';
      readonly name: string;
      readonly subject: Expr;
      readonly then: readonly Stmt[];
      readonly otherwise?: readonly Stmt[];
      readonly span: Span;
    }
  | {
      readonly kind: 'while';
      readonly condition: Expr;
      readonly body: readonly Stmt[];
      readonly span: Span;
    }
  /**
   * `await fixedTime(500ms)` — suspend until a clock reaches a duration.
   *
   * The clock is part of the syntax rather than a callable, because there is nothing to call: the
   * three names are the only three clocks a loop has, and making them functions would mean a
   * `fixedTime` a script could pass around, store, or invoke outside an await — none of which has
   * a meaning. What would make that wrong is a host that grows a fourth clock, which would be a
   * change to the loop rather than to a library.
   */
  | {
      readonly kind: 'await';
      readonly clock: 'fixed' | 'frame' | 'wall';
      readonly duration: Expr;
      readonly span: Span;
    }
  /** `become Opening` — leave the current state and enter another. Only inside a `state`. */
  | { readonly kind: 'become'; readonly state: string; readonly span: Span }
  /**
   * `await settle()` — start a task and suspend until it finishes.
   *
   * A separate node from the clock await because they suspend on different things, and a reader of
   * either should not have to check which one a shared node is.
   */
  | {
      readonly kind: 'awaitTask';
      readonly task: string;
      readonly args: readonly Expr[];
      readonly span: Span;
    }
  /** `emit Alarm { strength: 0.8 }` — deliver an event to everything listening, now. */
  | {
      readonly kind: 'emit';
      readonly event: string;
      readonly fields: readonly { readonly name: string; readonly value: Expr; readonly span: Span }[];
      readonly span: Span;
    }
  /** `spawn pulse()` — start a task, owned by whatever encloses this statement. */
  | {
      readonly kind: 'spawn';
      readonly task: string;
      readonly args: readonly Expr[];
      readonly span: Span;
    }
  /**
   * `scope effect { … }` — a block that cancels what it started when it ends.
   *
   * The name is a label rather than a binding: nothing in the language refers to a scope, because
   * the only two things one can do to a scope are done by entering and leaving the block. A name
   * that could be passed would be a scope a script could leave from somewhere else, which is the
   * detached ownership the form exists to remove.
   */
  | {
      readonly kind: 'scope';
      readonly name: string;
      readonly body: readonly Stmt[];
      readonly span: Span;
    }
  | { readonly kind: 'expr'; readonly expr: Expr; readonly span: Span };

/**
 * `@editor(…)` on a field — what an inspector shows, when one exists.
 *
 * **The compiler emits this whether or not an editor exists**, which is the asymmetry the design
 * argues is the useful part: the compiler knows the metadata, an editor consumes it when present,
 * and a shipping build may strip it entirely. Checking it needs no editor at all — a range on a
 * field that holds text is wrong today, with nothing anywhere to display it.
 */
export interface EditorMeta {
  readonly label?: string;
  readonly category?: string;
  /** `1m..150m`. The unit is kept so it can be checked against the field's own. */
  readonly range?: {
    readonly min: number;
    readonly max: number;
    readonly unit?: string;
    readonly span: Span;
  };
  readonly assetType?: { readonly name: string; readonly span: Span };
  readonly span: Span;
}

export interface FieldDecl {
  readonly name: string;
  /**
   * `@id("phase")` — the name this field's id keeps, whatever the field is now called.
   *
   * A field id is built from the field's *name*, so renaming one retires the old id and mints a
   * new one: a migration then drops the value and fills the new field from its default. That is
   * correct when a rename means a different thing and wrong when it means the same thing spelled
   * better, and only the author knows which. This is how they say.
   */
  readonly id?: string;
  readonly type: TypeRef;
  readonly default?: Expr;
  /** `@editor(…)`, when the field carries one. Emitted onto the field's schema entry. */
  readonly editor?: EditorMeta;
  readonly span: Span;
}

export interface DataDecl {
  readonly kind: 'data';
  readonly name: string;
  /**
   * `@substance`, `@reaction` — assertions about the record's shape, checked and then erased.
   *
   * A record carried none at first: every annotation before them attached to something with a
   * body. These attach to a table of numbers, and what they assert is that the table is complete.
   */
  readonly annotations: readonly string[];
  /**
   * The record this one extends, when it declares one.
   *
   * **One base, and the span is kept because a refusal has to point at it.** Three of the four ways
   * a base clause is wrong — a cycle, a redeclared field, a base that is not a record — are reported
   * against the clause rather than against the record, and a caret at the top of a declaration sends
   * a reader to read the fields.
   */
  readonly base?: { readonly name: string; readonly span: Span };
  readonly fields: readonly FieldDecl[];
  readonly span: Span;
}

/**
 * `component Health { … }` — a component type this module declares, or asserts about its host.
 *
 * **Two directions, one form.** Without `from host` the language owns the shape: the compiler emits
 * a schema and the host builds a store from it, so the field ids carry this module's name and a
 * save survives a rename. With `from host` the declaration creates nothing and is checked when the
 * module binds — a shape written twice, with the second checked against the first rather than
 * trusted.
 *
 * The alternative to writing it twice was importing the host's schema, and it fails twice over:
 * generated code imports nothing, and the checker runs with no host present — a language server
 * open on a file with no project configured still has to type `e.Transform.x`.
 */
export interface ComponentDecl {
  readonly kind: 'component';
  readonly name: string;
  /** `component X from host { … }` — an assertion checked at bind, not a declaration. */
  readonly fromHost: boolean;
  readonly fields: readonly FieldDecl[];
  readonly span: Span;
}

/**
 * `entity Animal { require Transform … var target: Entity? }` — two mechanisms under one head.
 *
 * **The `require` list is a named component set**, expanded wherever the name is used as a query
 * term. **The `var` fields become an implicit component** named for the entity, with a schema like
 * any other; an entity with no `var` fields declares no component and is a name for a set.
 *
 * Separating the two is what makes the form tractable. A single reading — "an entity is a
 * component" or "an entity is a prefab without values" — makes one of the two examples in the
 * design unwritable, and the alternative considered was refusing the form in writing on exactly
 * that ground.
 */
export interface EntityDecl {
  readonly kind: 'entity';
  readonly name: string;
  /** Component names this entity requires, in declaration order. Spans kept so a refusal can point. */
  readonly requires: readonly { readonly name: string; readonly span: Span }[];
  /** `var` fields, which become an implicit component named for the entity. */
  readonly fields: readonly FieldDecl[];
  readonly span: Span;
}

/**
 * `system HungerSystem { reads … writes … uses … after … update at 1Hz { … } }`.
 *
 * **`reads` and `writes` are checked assertions rather than the source of truth.** The checker
 * infers a system's component access through the call graph the way `check/effects.ts` infers
 * effects, because component access is a property of the code in exactly that sense — and a
 * mandatory declaration would be a second philosophy for one kind of fact, and one the compiler
 * could have written itself. What a declaration buys is a mistake caught at the system that
 * claimed something rather than three files away.
 *
 * `everyTicks` is a **stride over fixed steps and never a rate in seconds**, which is the entity
 * model's rule one level down: a wall-clock rate leaves the determinism contract on its first
 * dropped frame, because two runs of the same recording would run the system a different number of
 * times. The conversion from `at 1Hz` happens in the parser, which is where the design says a rate
 * is written.
 */
export interface SystemDecl {
  readonly kind: 'system';
  readonly name: string;
  readonly reads: readonly { readonly name: string; readonly span: Span }[];
  readonly writes: readonly { readonly name: string; readonly span: Span }[];
  /**
   * `uses graph: NavGraph` — a host value this system is handed, bound under a name in its body.
   *
   * **A system takes no arguments, which is what this exists to answer.** A consumer reported it:
   * an opaque handle reaches a script only as a capability parameter, so a `fn` can take a path or
   * a graph and a `system` can take nothing at all — and the loop over entities moved into the
   * host, where the rule stops being the thing anybody can reload. What was left in the script was
   * a function the host called once per entity per step.
   *
   * **A resource is one per type**, which is why the type is here and the name is only a binding.
   * The host is asked for "the `NavGraph` this world has" rather than for "the thing this system
   * calls `graph`", so two systems naming it differently are handed the same object and a script
   * renaming its own binding changes nothing outside the file.
   *
   * The alternative was a component field holding a handle, which the report named first. It is
   * refused because a component is what a save file holds: its schema carries stable field ids, a
   * prefab gives every field a constant, and a scene load rewrites its entity columns. A host
   * object satisfies none of those three, so the field would be the one part of a component that
   * silently does not persist.
   */
  readonly uses: readonly {
    readonly name: string;
    readonly type: TypeRef;
    readonly span: Span;
  }[];
  /** Systems this one must run after, by name. A cycle in these is refused when the schedule builds. */
  readonly after: readonly { readonly name: string; readonly span: Span }[];
  /** Fixed-step stride. 1 when `update` carries no rate. */
  readonly everyTicks: number;
  readonly body: readonly Stmt[];
  readonly annotations: readonly string[];
  readonly span: Span;
}

/**
 * `prefab Guard { Transform {} Health { current: 100 } }` — a description, not a program.
 *
 * Values are expressions the checker requires to be constant, because a prefab is instantiated by
 * the host from data it holds: a value computed at spawn time would make a prefab a function, and
 * the thing that makes one worth having is that it can be inspected, serialised and edited without
 * being run.
 *
 * A component named here that no declaration reaches is a compile error rather than a bind-time
 * one, which is what the language owning a component's shape buys.
 */
export interface PrefabDecl {
  readonly kind: 'prefab';
  readonly name: string;
  readonly components: readonly {
    readonly name: string;
    readonly values: readonly {
      readonly name: string;
      readonly value: Expr;
      readonly span: Span;
    }[];
    readonly span: Span;
  }[];
  readonly span: Span;
}

export interface EnumVariant {
  readonly name: string;
  readonly payload?: TypeRef;
  readonly span: Span;
}

export interface EnumDecl {
  readonly kind: 'enum';
  readonly name: string;
  readonly variants: readonly EnumVariant[];
  readonly span: Span;
}

/**
 * A parameter, and why `mut` lives here rather than on the type.
 *
 * Were `PulseState` and `mut PulseState` different types, every signature accepting either would
 * double, and a consumer's type would fork the first time somebody needed to read one and write
 * another. Mutability is a property of the *binding*, which is also how `let` and `var` express it
 * one level down — so there is one idea in the language rather than two that look alike.
 */
export interface ParamDecl {
  readonly name: string;
  readonly type: TypeRef;
  readonly mutable: boolean;
  readonly span: Span;
}

export interface FnDecl {
  readonly kind: 'fn';
  readonly name: string;
  readonly annotations: readonly string[];
  /**
   * `@aiTool(description: "…")`, keyed `annotation.key`.
   *
   * A side map rather than a richer `annotations` array, so the twelve readers that
   * only ask whether a name is present are untouched.
   */
  readonly annotationArgs?: ReadonlyMap<string, string>;
  readonly params: readonly ParamDecl[];
  readonly returnType?: TypeRef;
  readonly body: readonly Stmt[];
  readonly span: Span;
}

/**
 * A task: a function that can suspend, compiled to a state machine rather than a promise chain.
 *
 * Deliberately not a flag on `FnDecl`. A task has no return type, may `await`, and emits as a
 * different kind of object entirely — three differences a reader of a shared node would have to
 * hold in their head, and three places a later pass could forget to check the flag.
 */
export interface TaskDecl {
  readonly kind: 'task';
  readonly name: string;
  readonly annotations: readonly string[];
  readonly params: readonly ParamDecl[];
  readonly body: readonly Stmt[];
  readonly span: Span;
}

/**
 * `event Alarm { source: Node, strength: f32 }`.
 *
 * A declaration of its own rather than a `data` record, so that `emit` and `on` can only name
 * something meant to be one. A record is a value a script passes around; an event is a name two
 * halves of a program agree on, and letting either stand in for the other would mean a typo in an
 * `emit` naming a record and compiling.
 */
export interface EventDecl {
  readonly kind: 'event';
  readonly name: string;
  readonly fields: readonly FieldDecl[];
  readonly span: Span;
}

/**
 * `on Alarm as alarm { … }` — a module-level handler.
 *
 * At the top level rather than inside a function, because its lifetime is the module's: it is
 * registered when the module loads and closed when the module is disposed, which is the advantage
 * over a subscription a script would have to remember to cancel.
 */
export interface OnDecl {
  readonly kind: 'on';
  readonly event: string;
  readonly binding: string;
  readonly body: readonly Stmt[];
  readonly span: Span;
}

/**
 * `state Closed { enter { … } on Open { … } }`.
 *
 * **Unrelated to a host's animation state machine**, and the distance is worth stating here where
 * a reader meets the word: that one blends poses between clips, and this one holds a name and runs
 * blocks. A reader who conflates them goes looking for a skeleton.
 *
 * Every `state` in a module is part of one machine, and the first declared is where it starts.
 * A module with more than one machine in it would need a name for each and a way to say which
 * states belong to which; a module *per* machine needs neither, and modules are cheap.
 */
export interface StateDecl {
  readonly kind: 'state';
  readonly name: string;
  /** The `enter` block, which is a task body: it may suspend, and is cancelled if the state is left. */
  readonly enter?: readonly Stmt[];
  readonly handlers: readonly {
    readonly event: string;
    /** `on Open as o { … }`. Absent where the state does not need the payload. */
    readonly binding?: string;
    readonly body: readonly Stmt[];
    readonly span: Span;
  }[];
  readonly span: Span;
}

export interface ImportDecl {
  readonly kind: 'import';
  readonly module: string;
  readonly names: readonly string[];
  /**
   * Whether this specifier names a file rather than a capability module.
   *
   * **Decided syntactically, at parse time, and never by a lookup.** A specifier whose category
   * depended on what a target manifest happened to contain would make one source mean two things in
   * two builds, and the disagreement would surface as a linker refusal about a file — which names
   * nothing a reader can act on.
   *
   * The cost is that a capability module may never be named with a leading `./`, which no host does
   * and which the registry would refuse anyway. What would make it wrong is a host wanting to
   * publish modules under relative names, which would be a host naming its capabilities after this
   * compiler's syntax.
   */
  readonly relative: boolean;
  readonly span: Span;
}

/**
 * `let SECONDS_PER_HOUR = 3600` at the top of a file.
 *
 * **A `let` with no function around it**, which the language did not have: `let` was a statement, so
 * a value shared by a whole file had to be written as a `@pure fn` returning it. A consumer reported
 * the cost as a reading problem rather than a speed one — a table of twelve constants became twelve
 * functions, and the place you go to change a number stopped looking like a table of numbers.
 *
 * **`var` is refused at this level and that is not an oversight.** Module-level mutable state is
 * state a hot reload has to migrate, a replay has to restore and two systems can race on, none of
 * which this language has an answer for. A constant has none of those problems because it cannot
 * change.
 */
export interface ConstDecl {
  readonly kind: 'const';
  readonly name: string;
  /** The written annotation, or absent when the value's own type is taken. */
  readonly type?: TypeRef;
  readonly value: Expr;
  readonly span: Span;
}

export type Decl =
  | DataDecl
  | ConstDecl
  | FnDecl
  | EnumDecl
  | TaskDecl
  | EventDecl
  | OnDecl
  | StateDecl
  | ComponentDecl
  | EntityDecl
  | SystemDecl
  | PrefabDecl;

export interface Module {
  readonly imports: readonly ImportDecl[];
  readonly decls: readonly Decl[];
}

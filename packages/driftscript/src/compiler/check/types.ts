/**
 * The small type core, and what it deliberately does not contain.
 *
 * `Vec3`, `Quat`, `Mat4`, `Transform` and `Color` are **not** here and never will be. They arrive
 * through a linked capability, from whatever maths the host already has, because a consumer with no
 * renderer still has a language. That single omission is most of what makes this package
 * host-neutral — a type core that knew what a transform was would be a type core that knew it had a
 * scene.
 *
 * **`Option` and `Result` are built in; user-defined generics are not.**
 *
 * The design names exactly two parameterised types in the language core, and both are about failure
 * rather than about abstraction: an option because there is no implicit null, and a result because
 * failure is a value rather than an exception. Building those two directly costs a variant each.
 * Building a general parameter system costs inference, variance, constraints and instantiation —
 * and buys nothing the design asks for, since `Handle<Entity>` is a *capability's* type and arrives
 * described rather than declared.
 *
 * The cost is that a consumer cannot write their own container. What would make that wrong is a
 * corpus file that needs one, which is exactly what the corpus is read for before the syntax
 * freezes.
 */

export type Type =
  | { readonly kind: 'primitive'; readonly name: string }
  | {
      readonly kind: 'data';
      readonly name: string;
      /**
       * Every field, **base-most first**, flattened.
       *
       * The order is what `__drift.shapes` carries and what a hot reload compares, so it is part of
       * the type rather than something a consumer recomputes. It is a `Map` filled during base
       * resolution rather than at declaration, because a record's own fields are known before its
       * base's are.
       */
      readonly fields: ReadonlyMap<string, Type>;
      /**
       * The record this one extends, when the base clause resolved.
       *
       * Absent when there was no clause *and* when there was one that was refused — a relation that
       * was reported as wrong must not still be claimed here, or a `Wolf` would go on being accepted
       * where a `Dog` is wanted on the strength of a base the checker rejected.
       */
      /*
       * The type rather than the name, so `assignable` can walk the chain without a lookup — it is
       * a pure function of two types, and giving it a scope to consult would make it a method on the
       * checker. Chains are finite because a cycle is refused before this is ever set.
       */
      readonly base?: Type;
    }
  | {
      readonly kind: 'enum';
      readonly name: string;
      /** Variant name to its payload type, or `null` for a variant that carries nothing. */
      readonly variants: ReadonlyMap<string, Type | null>;
    }
  /**
   * An entity handle — what a query loop binds.
   *
   * A kind of its own rather than `f64`, so `e.Health` is legal on a handle and not on every number
   * a script holds. It is *assignable to* `f64` and not from one: a handle spends the whole 53-bit
   * budget a double holds and every `drift/ecs` capability takes it as an `f64`, so passing one
   * across is exact — while an arbitrary number is not a handle, and accepting one would put the
   * generational check this language has back where it was.
   *
   * **What this costs** is an asymmetry a reader has to know about. **What would make it wrong** is
   * a capability that hands *back* a handle as an `f64` and expects it to keep working as one,
   * which is why `drift/ecs` should return this type once it can name it.
   */
  | { readonly kind: 'entity' }
  | { readonly kind: 'option'; readonly inner: Type }
  | { readonly kind: 'result'; readonly ok: Type; readonly err: Type }
  | { readonly kind: 'void' }
  /**
   * The type of an expression the checker could not resolve.
   *
   * It exists so that one unresolved name produces one diagnostic rather than one per use. An error
   * type is compatible with everything and reports nothing, which stops a single unknown
   * declaration from burying the real mistakes underneath a page of consequences.
   */
  | { readonly kind: 'error' };

export const ERROR: Type = { kind: 'error' };
export const VOID: Type = { kind: 'void' };
export const BOOL: Type = { kind: 'primitive', name: 'bool' };
export const STRING: Type = { kind: 'primitive', name: 'String' };

export function primitive(name: string): Type {
  return { kind: 'primitive', name };
}

/**
 * A primitive type name, as either path into the checker resolves it.
 *
 * **`Entity` lexes as a primitive and is not a `primitive` Type**, and that mismatch is the whole
 * reason this function exists rather than two call sites doing it. A written annotation resolved it
 * correctly and a *capability signature* did not: `resolveTypeName` fell through to
 * `primitive('Entity')`, so a host that returned a handle got a type on which `.Health` was refused
 * with "`Entity` has no fields" and which the `mut` exemption did not recognise. The two paths
 * disagreed about what one word meant, and only one of them was ever exercised.
 *
 * `types.ts` had predicted exactly this — the `entity` kind's own comment says `drift/ecs` should
 * return the type "once it can name it". It could name it; naming it produced something broken.
 */
export function primitiveType(name: string): Type {
  return name === 'Entity' ? { kind: 'entity' } : primitive(name);
}

export function option(inner: Type): Type {
  return { kind: 'option', inner };
}

export function result(ok: Type, err: Type): Type {
  return { kind: 'result', ok, err };
}

/** The primitives that arithmetic accepts. `String` is not one of them, which is the point. */
const NUMERIC: ReadonlySet<string> = new Set([
  'i8',
  'i16',
  'i32',
  'i64',
  'u8',
  'u16',
  'u32',
  'u64',
  'f32',
  'f64',
]);

/**
 * The float primitives, whose one conversion is rounding to the nearest representable value.
 *
 * A set of its own beside `INTEGERS` because the two answer different questions and a conversion
 * asks both: an integer narrowing has three intents and needs three spellings, a float conversion
 * has one and needs one. See `checkConversion`, which branches on exactly these two sets.
 */
export const FLOATS: ReadonlySet<string> = new Set(['f32', 'f64']);

/** The integer primitives, whose overflow behaviour is always chosen rather than assumed. */
export const INTEGERS: ReadonlySet<string> = new Set([
  'i8',
  'i16',
  'i32',
  'i64',
  'u8',
  'u16',
  'u32',
  'u64',
]);

/** How many bits each integer holds, and whether it is signed. Used by the conversion rules. */
export const INTEGER_RANGE: Readonly<Record<string, { bits: number; signed: boolean }>> = {
  i8: { bits: 8, signed: true },
  i16: { bits: 16, signed: true },
  i32: { bits: 32, signed: true },
  i64: { bits: 64, signed: true },
  u8: { bits: 8, signed: false },
  u16: { bits: 16, signed: false },
  u32: { bits: 32, signed: false },
  u64: { bits: 64, signed: false },
};

export function isNumeric(type: Type): boolean {
  return type.kind === 'primitive' && NUMERIC.has(type.name);
}

export function isBool(type: Type): boolean {
  return type.kind === 'primitive' && type.name === 'bool';
}

/*
 * A type predicate rather than a plain boolean, unlike `isNumeric` and `isBool` beside it.
 *
 * The float check has one caller that needs the *name* immediately afterwards — capability-call
 * width resolution reads `f32` or `f64` off the type it just accepted — and narrowing at the test
 * is what stops that caller from re-testing the kind to satisfy the compiler.
 */
export function isFloat(type: Type): type is { kind: 'primitive'; name: string } {
  return type.kind === 'primitive' && FLOATS.has(type.name);
}

/** A name for a type, as a diagnostic prints it. */
export function nameOf(type: Type): string {
  switch (type.kind) {
    case 'primitive':
      return type.name;
    case 'data':
    case 'enum':
      return type.name;
    case 'entity':
      return 'Entity';
    case 'option':
      return `${nameOf(type.inner)}?`;
    case 'result':
      return `Result<${nameOf(type.ok)}, ${nameOf(type.err)}>`;
    case 'void':
      return 'void';
    case 'error':
      return '<unresolved>';
  }
}

/**
 * Whether a value of `from` may be used where `to` is expected.
 *
 * Deliberately exact: a primitive matches its own name and nothing else, so `u8` does not silently
 * widen to `u32`. The design gives three spellings for a narrowing because the compiler should not
 * guess which intent a conversion had — and a language that widens silently has already guessed
 * once, in the direction people forget to check.
 *
 * **There is no assignment from `T` to `T?`.** A language that let a bare value flow into an option
 * position has re-invented implicit null in the other direction: the reader of a `T?` can no longer
 * tell whether the absence is meaningful or merely never filled in. `some(x)` is how a value
 * becomes an option, and it is one word.
 *
 * `error` is assignable both ways so an unresolved type reports once at its source.
 */
export function assignable(from: Type, to: Type): boolean {
  if (from.kind === 'error' || to.kind === 'error') return true;
  /*
   * A handle is exactly an `f64`, so it crosses into one — see the `entity` kind for why this is
   * one-way. It sits above the kind check because the two kinds differ by construction.
   */
  if (from.kind === 'entity' && to.kind === 'primitive' && to.name === 'f64') return true;
  if (from.kind !== to.kind) return false;

  switch (from.kind) {
    case 'primitive':
      return to.kind === 'primitive' && from.name === to.name;
    /**
     * A record is assignable to any record in its base chain, and to nothing else.
     *
     * **Width subtyping, and it is sound here for two reasons that are properties of this language
     * rather than of subtyping.** There are no collection types — `Type` is primitive, data, enum,
     * option, result, void and error — so there is no mutable container to be unsound through, and
     * `mut [Dog]` accepting a `[Wolf]` cannot arise. And whole-record assignment to a `mut`
     * parameter compiles to a local rebinding the caller never sees, so replacing a `Wolf` through
     * a `mut Dog` parameter cannot erase its extra fields.
     *
     * **The first of those is the clause a collection type would invalidate**, so whoever adds one
     * reads this: arrays need an invariance rule written at the same time, or this becomes unsound
     * the day they land.
     *
     * The walk is up one chain, never to a common ancestor: two records sharing a base are siblings
     * and are not each other's subtypes. Nominal, not structural — two records with identical
     * fields are still two types, and the day one gains a field the other does not, code that
     * relied on the coincidence breaks somewhere else entirely.
     */
    case 'data': {
      if (to.kind !== 'data') return false;
      for (let step: Type | undefined = from; step?.kind === 'data'; step = step.base) {
        if (step.name === to.name) return true;
      }
      return false;
    }
    case 'enum':
      return to.kind === 'enum' && from.name === to.name;
    case 'option':
      return to.kind === 'option' && assignable(from.inner, to.inner);
    case 'result':
      return (
        to.kind === 'result' && assignable(from.ok, to.ok) && assignable(from.err, to.err)
      );
    case 'void':
      return true;
    /*
     * A handle is assignable only to a handle. The one-way crossing into `f64` is decided above,
     * before the kind check, because the two kinds differ by construction and would never reach a
     * `case` at all.
     */
    case 'entity':
      return to.kind === 'entity';
  }
}

/** Whether two types are the same, which `match` arms and `if`/`else` branches both need. */
export function same(a: Type, b: Type): boolean {
  return assignable(a, b) && assignable(b, a);
}

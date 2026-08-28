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
  /**
   * `List<T>` — the language's one container, and the reason `assignable` has an invariance rule.
   *
   * **Added because everything with a variable number of elements had nowhere to live.** A consumer
   * reported it precisely: the ECS is the collection when the elements are entities, and when they
   * are not — lines already spoken, tables already set up, a queue at a counter — the logic moved
   * into the host, which is the wrong place for a rule somebody wants to hot-reload. A
   * twenty-two-line chain of `if` stood in for an array index.
   *
   * **Invariant, and that is not a preference.** The comment on `data` below says width subtyping
   * is sound here partly because there are no containers, and names this as the clause a collection
   * type would invalidate. It is right: with covariance, a `List<Wolf>` passed where a `List<Dog>`
   * is wanted could have a plain `Dog` pushed into it, and the caller's next read would find a
   * `Dog` in a list whose type says `Wolf`. So a list matches its element type exactly.
   *
   * The cost is that a helper over `List<Dog>` cannot be called with a `List<Wolf>`. There is no
   * generic `fn`, so the alternative was never available anyway.
   */
  | { readonly kind: 'list'; readonly of: Type }
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

export function list(of: Type): Type {
  return { kind: 'list', of };
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

/**
 * The largest integer a JavaScript number holds exactly: `2^53 - 1`.
 *
 * Written as the expression rather than the digits, because the digits are the thing a reader
 * cannot check.
 */
const EXACT = 2 ** 53 - 1;

/**
 * The values of an integer type this backend can actually represent, and whether that is all of
 * them.
 *
 * ---
 *
 * **`i64` and `u64` name sixty-four bits of storage and cannot hold sixty-four bits of value here.**
 * A JavaScript number is an IEEE-754 double: every integer up to `2^53 - 1` is exact and beyond
 * that they are not — `9007199254740993` is not representable at all, and the arithmetic above the
 * boundary skips values rather than approximating them. A range check cannot repair a number whose
 * low bits are already gone.
 *
 * The nominal width still means something, and that is why the types stay. A component column
 * declared `i64` is a `Float64Array` on the engine's side, a schema records the width a save file
 * reserves, and a host reading the metadata is told what it is being handed. What changes is that
 * the *language* now refuses to produce a value it cannot represent, instead of producing a wrong
 * one: the domain below is what `+`, `-`, `*`, `.checked` and `.clamp` are held to.
 *
 * **`BigInt` was the other answer and is wrong for this language.** A BigInt allocates per
 * operation, so `@hot` would have to reject all 64-bit arithmetic — the type would be unusable on
 * exactly the per-frame path this language exists for — and it would fork the capability ABI, the
 * schemas, state serialisation and every `JSON.stringify` in the metadata. **What would make this
 * paragraph wrong** is a backend whose numbers are not doubles, at which point the domain stops
 * being a property of the type and moves behind the backend that knows.
 */
export function integerDomain(name: string): { lo: number; hi: number; exact: boolean } {
  const range = INTEGER_RANGE[name];
  if (range === undefined) return { lo: 0, hi: 0, exact: false };

  const lo = range.signed ? -(2 ** (range.bits - 1)) : 0;
  const hi = range.signed ? 2 ** (range.bits - 1) - 1 : 2 ** range.bits - 1;
  if (hi <= EXACT && lo >= -EXACT - 1) return { lo, hi, exact: true };

  /*
   * Symmetric, so that negating a value in the domain stays in it. A two's-complement `-2^53` would
   * be one more value at the bottom and `-(-2^53)` would then be an overflow — a rule about
   * representability turning into a rule about sign, for one number nobody asked for.
   */
  return { lo: range.signed ? -EXACT : 0, hi: EXACT, exact: false };
}

/**
 * Whether wrapping arithmetic is expressible for this type on this backend.
 *
 * **It is not, for the 64-bit types, and refusing is the only honest answer.** Wrapping is defined
 * on the true mathematical result: `a +% b` is the sum reduced into the domain. Every other integer
 * width can compute that sum exactly first — two `u32`s add to at most `2^33 - 2`, which a double
 * holds — and then reduce it. Two values at the top of the 64-bit exact domain add to nearly
 * `2^54`, where doubles are two apart and an odd sum has already been rounded before anything can
 * reduce it. There is no order of operations that recovers it.
 *
 * So `+%`, `-%`, `*%` and `.wrap` are refused on `i64` and `u64` by name, rather than computing
 * something that is wrapping-shaped and wrong. Checked and saturating arithmetic are unaffected:
 * both only need to be exact *inside* the domain, and a result outside it either throws or clamps.
 */
export function wrapsExactly(name: string): boolean {
  return integerDomain(name).exact;
}

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
    case 'list':
      return `List<${nameOf(type.of)}>`;
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
    /*
     * **Invariant: same element type, exactly.** See the `list` kind for why covariance would make
     * the record rule below unsound, and the `data` case for the sentence this answers.
     */
    case 'list':
      return to.kind === 'list' && same(from.of, to.of);
    /**
     * A record is assignable to any record in its base chain, and to nothing else.
     *
     * **Width subtyping, and it is sound here for two reasons that are properties of this language
     * rather than of subtyping.** There is exactly one container, `List<T>`, and **it is invariant**
     * — so a `List<Dog>` accepts a `List<Dog>` and nothing else, and pushing a `Dog` through a
     * reference whose real list holds `Wolf` cannot arise. And whole-record assignment to a `mut`
     * parameter compiles to a local rebinding the caller never sees, so replacing a `Wolf` through
     * a `mut Dog` parameter cannot erase its extra fields.
     *
     * **The first clause used to read "there are no collection types", and the paragraph told
     * whoever added one to write an invariance rule in the same commit or make this unsound.** That
     * is what `List<T>` did; the rule is the `list` case below, and this sentence is kept so the
     * next container arrives knowing the constraint rather than discovering it.
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

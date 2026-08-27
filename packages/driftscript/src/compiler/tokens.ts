/**
 * The token table, and the reason it is data rather than a switch.
 *
 * The TextMate grammar's token sets are generated from this file, on the same reasoning
 * `AGENTS.md` gives for generating WGSL from GLSL: **the direction is the safety property.** A
 * grammar that drifts from the lexer still highlights, so the failure is silent — where a
 * generator that reads this table cannot drift at all.
 *
 * The cost is that adding a keyword means editing a list rather than a parser branch, and that
 * `npm run grammar` must run after. What would make it wrong is a keyword whose meaning depends on
 * where it appears, because a flat set cannot express one — so this language has no contextual
 * keywords, and acquiring one is the change that would break the generator rather than the lexer.
 *
 * **Nothing else in the compiler may declare a keyword.** A second list is a second definition of
 * the language.
 */

/**
 * Every reserved word, including the primitive type names.
 *
 * Primitives are keywords rather than identifiers resolved by the checker so that the grammar and
 * the parser cannot disagree about `f32`. The alternative — a primitive as an ordinary identifier
 * — would highlight as a variable until the checker got to it, and highlighting runs where the
 * checker does not.
 */
export const KEYWORDS = [
  'let',
  'var',
  'fn',
  'task',
  'await',
  'spawn',
  'state',
  'become',
  'enter',
  'data',
  'enum',
  'event',
  'match',
  'import',
  'from',
  'if',
  'else',
  'return',
  'while',
  'for',
  'in',
  'break',
  'continue',
  'on',
  'emit',
  'scope',
  'mut',
  'as',
  'component',
  'entity',
  'system',
  'prefab',
  'require',
  'reads',
  'writes',
  'update',
  'at',
  'after',
  'query',
  'true',
  'false',
  'bool',
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
  'String',
  'Entity',
] as const;

/**
 * The subset of `KEYWORDS` that names a type.
 *
 * The checker reads this; the lexer does not, because to the lexer a primitive is a keyword like
 * any other. Kept as its own list rather than derived by a predicate so that adding `f16` later is
 * one edit in two places that both fail loudly rather than one edit and a silent omission.
 */
export const PRIMITIVES = [
  'bool',
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
  'String',
  'Entity',
] as const;

/** Annotations, which are assertions the compiler checks rather than information it needs. */
export const ANNOTATIONS = [
  'pure',
  'deterministic',
  'hot',
  'replicated',
  'aiTool',
  'aiContext',
  'editor',
  /*
   * The chemistry surface's two, and the design argues why they are annotations rather than language
   * forms: a
   * substance is a record of numbers with no control flow, no effects and no call graph, so it needs
   * a shape check and not a scope. `@editor` is the precedent for exactly that.
   */
  'substance',
  'reaction',
] as const;

/**
 * Unit suffixes, erased at compile time.
 *
 * `m/s` is deliberately absent: it is a composite the parser builds from `m`, `/` and `s`, and a
 * table entry for it would make this set unclosed the moment somebody wants an acceleration.
 *
 * **Longest first, because the lexer matches greedily.** `ms` must be found before `m`, `mol` before
 * both, `degC` before `deg`, and `kPa` before `Pa`. Sorting this list any other way lexes `2mol` as
 * `2`, `m`, `ol` and reports a syntax error three tokens from the cause.
 *
 * The eleven at the end arrived with `drift/chemistry`, and `degC` is the only one in the
 * language that is not a pure scale — see `UNIT_SCALE`.
 */
export const UNIT_SUFFIXES = [
  'degC', 'kPa', 'mol', 'deg', 'rad', 'ms', 'Hz', 'kJ', 'MJ', 'kg', 'Pa',
  'J', 'K', 'W', 'g', 'm', 's',
] as const;

/**
 * Punctuation and operators, longest first.
 *
 * The order is load-bearing rather than tidy: the lexer takes the first entry that matches at the
 * cursor, so `+=` must precede `+` and `+%` must precede both. Sorting this list alphabetically
 * would lex `a += b` as `a`, `+`, `=`, `b` and the parser would report a syntax error pointing at
 * the wrong character.
 *
 * The overflow operators come first of all. `+%` is wrapping and `+|` is saturating; the spelling
 * may move during implementation but the three-way distinction may not, because there is no
 * undefined integer behaviour in this language.
 */
export const PUNCTUATION = [
  '||',
  '&&',
  '+%',
  '+|',
  '-%',
  '-|',
  '*%',
  '*|',
  '+=',
  '-=',
  '*=',
  '/=',
  '==',
  '!=',
  '<=',
  '>=',
  '=>',
  '?.',
  '..',
  '->',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ',',
  ':',
  ';',
  '.',
  '?',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '!',
  '|',
  '&',
] as const;

/**
 * Keywords that may also be used as an identifier, and the collision that forced the distinction.
 *
 * **The design contradicts itself here and this is the resolution.** §8 lists `state` among the
 * keywords; §48's canonical first example — the one the plan says to keep verbatim — is
 * `fn update(state: mut PulseState, dt: f32)`. Reserved, that example does not parse. Checking the
 * rest of the list found seven more of the same shape: `fn lerp(from:, to:)`,
 * `fn process(data:)`, `fn run(task:)`, `fn within(scope:)`, `fn pick(match:)`,
 * `fn place(on:)`, `fn cast(as:)`. Every one is a signature a behaviour-scripting language will
 * actually be asked to parse.
 *
 * Three ways out, and the first two are worse:
 *
 * - **Remove them from `KEYWORDS`.** Then `state Idle { … }` cannot be a declaration, and the
 *   state-machine syntax has to find another word for the thing it is actually declaring.
 * - **Rename them.** §8 does say of the overflow operators that a spelling may move where a
 *   semantic distinction may not — but `state` is the right word for a state, and spending the
 *   language's clearest nouns to avoid a parser problem is paying in the wrong currency.
 * - **Reserve them only where they can start a construct**, which is what real languages do with
 *   contextual keywords and what this set records.
 *
 * The rule: in a **binding or expression position** — a parameter name, a field name, a member
 * after `.`, an imported name — a soft keyword is an identifier. In a **leading position**, where
 * the parser is choosing which construct follows, it is a keyword.
 *
 * **The cost is highlighting, and it is paid deliberately.** The generated TextMate grammar reads
 * `KEYWORDS` and cannot see position, so `state` in `fn update(state: …)` highlights as a keyword
 * when it is a parameter. That is the same imperfection every mainstream editor grammar carries
 * for its own contextual keywords, and it is cosmetic where the alternatives are semantic.
 *
 * What would make this wrong is a construct whose leading keyword cannot be told from an
 * expression by one token of lookahead. `state Idle {` versus `state.phase +=` is decided by the
 * second token. A future form that is not is a form that needs a different word.
 */
export const SOFT_KEYWORDS = [
  'state',
  'component',
  'entity',
  'system',
  'prefab',
  'require',
  'reads',
  'writes',
  'update',
  'at',
  'become',
  'enter',
  'task',
  'data',
  'from',
  'on',
  'scope',
  'match',
  'as',
  'in',
  'emit',
  'after',
] as const;

/*
 * `query` is deliberately absent from the list above, and it is the only one of the eleven
 * entity-form keywords that is hard.
 *
 * `query<Transform, Health>()` needs type arguments at a **call site**, where `<` is otherwise a
 * comparison — so a soft `query` would leave `query < 5` ambiguous between a comparison of a
 * variable and the head of a query, and the parser cannot resolve that without the checker's
 * knowledge of what `query` is. A hard keyword settles it at the token.
 *
 * **What this costs** is a variable named `query`. **What would make it wrong** is a consumer
 * wanting a cursor held and re-iterated across loops, which is a question about the entity model's
 * cursor pool rather than about syntax — and the pool is where it would be answered.
 */

const SOFT_SET: ReadonlySet<string> = new Set(SOFT_KEYWORDS);

/** Whether this keyword may stand where an identifier is expected. */
export function isSoftKeyword(text: string): boolean {
  return SOFT_SET.has(text);
}

export type Keyword = (typeof KEYWORDS)[number];
export type Primitive = (typeof PRIMITIVES)[number];
export type Annotation = (typeof ANNOTATIONS)[number];

const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);
const PRIMITIVE_SET: ReadonlySet<string> = new Set(PRIMITIVES);

export function isKeyword(text: string): text is Keyword {
  return KEYWORD_SET.has(text);
}

export function isPrimitive(text: string): text is Primitive {
  return PRIMITIVE_SET.has(text);
}

/**
 * What the compiler says when it refuses, and why it says it rather than throwing.
 *
 * A compiler that throws reports one error. This language's front end reports every independent
 * error it can find in a pass, because the alternative is a user fixing a file in as many rounds
 * as it has mistakes — and because a language server cannot show a squiggle for an exception.
 *
 * `AGENTS.md`'s reliability rule is the same shape read from the other side: fail fast at init,
 * never throw in the frame loop. Compilation is neither, so it does the third thing and returns
 * what it found.
 *
 * The cost is that every stage has to thread diagnostics through its return value rather than
 * unwinding. What would make it wrong is a failure so structural that continuing produces
 * nonsense — and that case exists, which is why `compileDriftScript` stops at the first *stage*
 * that failed rather than at the first diagnostic.
 */

/**
 * The code space, allocated once and by category.
 *
 * ```text
 * DS0001–DS0099   lexical
 * DS0100–DS0199   syntax
 * DS0200–DS0299   types and effects
 * DS0300–DS0399   linking
 * DS0400–DS0499   the hot path
 * ```
 *
 * Allocated in blocks rather than sequentially because a consumer greps for a code and a code that
 * moved is a broken grep — so a code is never renumbered once it ships, and a block leaves room to
 * add without renumbering. The cost is that a category is capped at a hundred; what would make it
 * wrong is a category needing more, at which point it gets a second block rather than a reshuffle.
 */
export type DiagnosticCode = `DS${string}`;

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly file: string;
  /** Byte offset into the source, inclusive. */
  readonly start: number;
  /** Byte offset into the source, exclusive. */
  readonly end: number;
}

/** A one-based line and column, which is what an editor and a human both count in. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/**
 * Where an offset falls, counted from one.
 *
 * Offsets are what the lexer and parser carry, because arithmetic on them is cheap and a span is
 * two of them. Lines and columns are what a person reads. Converting at the boundary rather than
 * carrying both is what keeps a token to two numbers — and this is called once per diagnostic
 * rather than once per token, so the linear scan is not on any path that matters.
 */
export function positionAt(source: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

/** The source line containing an offset, without its terminator. */
function lineAt(source: string, offset: number): { text: string; start: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let start = clamped;
  while (start > 0 && source.charCodeAt(start - 1) !== 10) start -= 1;
  let end = clamped;
  while (end < source.length && source.charCodeAt(end) !== 10) end += 1;
  return { text: source.slice(start, end), start };
}

/** The indent shared by the quoted source line and the caret line, so the two align. */
const GUTTER = '  ';

/**
 * A diagnostic as a person reads it: a location, a code, a message, the line, and a caret.
 *
 * The caret spans the whole error rather than marking its first character, because the width is
 * information — a type mismatch over one identifier and one over a whole expression look different
 * and should. A zero-width span still draws one caret, since an error at a position is still
 * somewhere.
 *
 * The source line and the caret line carry the same `GUTTER`, which is what makes them line up.
 * Changing one without the other is the whole failure mode this function has, and the test that
 * compares the caret's index against the source line's is what holds it.
 */
export function formatDiagnostic(diagnostic: Diagnostic, source: string): string {
  const { line, column } = positionAt(source, diagnostic.start);
  const { text } = lineAt(source, diagnostic.start);

  const head = `${diagnostic.file}:${line}:${column}  ${diagnostic.code}  ${diagnostic.message}`;

  /*
   * The caret stops at the end of the line even when the span runs past it.
   *
   * A span crossing a newline is real — an unterminated string is the obvious one — and drawing
   * its full width would run the carets off into the next line's text. Clamping loses information
   * about the second line and keeps the picture readable, which is the right trade for a first
   * line that already names the file and the position.
   */
  const width = Math.max(1, Math.min(diagnostic.end, diagnostic.start + text.length) - diagnostic.start);

  return [head, GUTTER + text, GUTTER + ' '.repeat(column - 1) + '^'.repeat(width)].join('\n');
}

/**
 * Canonical formatting, from the token stream rather than from the tree.
 *
 * **The tree is the wrong input and the IR is worse.** Both drop comments, and the IR additionally
 * erases units, expands compound assignment and folds sugar — so a formatter built on either would
 * rewrite `a += b` to `a = a + b` and `250ms` to `0.25` while claiming to have adjusted whitespace.
 * The token stream keeps every one of those, which is why the lexer emits comments as tokens that
 * the parser then discards.
 *
 * **The property that matters is that formatting cannot change what a program means.** A formatter
 * that reflows `a +% b` into `a + b` has silently changed overflow behaviour, and nobody reviewing
 * a whitespace diff would look. That is asserted by comparing the lowered IR before and after, with
 * spans stripped — a structural comparison rather than a textual one, because the spans are exactly
 * what formatting is allowed to move.
 *
 * **It normalises spacing and indentation and does not reflow.** The author's line structure is
 * kept as written: a block on one line stays on one line, and a long expression is never split.
 *
 * That is a decision rather than a limitation admitted late. Working from tokens, this cannot see
 * where an expression's sub-expressions are, so it could only reflow the things it *can* see —
 * braces — and a formatter that reflows braces while leaving expressions alone is inconsistent in a
 * way that shows. It also broke idempotency on its first run: `Door { open: false }` is a record
 * literal, not a block, and forcing its brace onto a new line then re-indenting its contents drifted
 * by a space every pass.
 *
 * What would make this wrong is a line-length rule, which this formatter deliberately does not
 * have — and which is the point at which it would need the tree and would have to solve comment
 * attachment properly.
 */
import type { Diagnostic } from '../diagnostics.ts';
import { type Token, tokenize } from '../lexer.ts';
import { parse } from '../parser.ts';

export interface FormatResult {
  readonly text: string;
  readonly diagnostics: readonly Diagnostic[];
}

const INDENT = '    ';

/** Tokens after which a space is never written. */
const NO_SPACE_AFTER: ReadonlySet<string> = new Set(['(', '[', '!', '.', '?.']);

/** Tokens before which a space is never written. */
const NO_SPACE_BEFORE: ReadonlySet<string> = new Set([
  ',',
  ';',
  ':',
  ')',
  ']',
  '.',
  '?.',
  '?',
  '(',
]);

/** How many newlines separate two offsets in the source, capped at what formatting preserves. */
function breaksBetween(source: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i += 1) {
    if (source.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/**
 * Whether a space belongs between two adjacent tokens.
 *
 * Written as a pair rule rather than a per-token property because spacing is a property of the
 * *join*: `-` is unary in `(-x)` and binary in `a - x`, and only the token before it says which.
 */
function needsSpace(previous: Token, next: Token): boolean {
  if (NO_SPACE_AFTER.has(previous.text) && previous.kind === 'punct') return false;
  if (NO_SPACE_BEFORE.has(next.text) && next.kind === 'punct') {
    /* `(` takes a space after a keyword — `if (a)`, `while (a)` — and none after a name, which is
       a call. That distinction is the one place spacing depends on what a token *is* rather than
       what it says. */
    if (next.text === '(') return previous.kind === 'keyword';
    return false;
  }
  /* A unit suffix belongs to the number before it: `250ms`, never `250 ms`. */
  if (next.kind === 'unit') return false;
  /* An annotation's name is part of it, and the lexer already delivers `@name` as one token. */
  return true;
}

/**
 * Format a source file.
 *
 * **A file with a syntax error is returned unchanged**, with its diagnostics. Half-formatting a
 * file nobody could parse produces a diff a reader cannot review and, worse, can move a brace past
 * the error and change which block a statement is in. Returning the input is the only answer that
 * cannot make things worse.
 */
export function format(source: string, file = '<anonymous>'): FormatResult {
  const parsed = parse(source, file);
  if (parsed.diagnostics.length > 0) return { text: source, diagnostics: parsed.diagnostics };

  const { tokens } = tokenize(source, file);
  const out: string[] = [];
  let depth = 0;
  let atLineStart = true;
  let previous: Token | null = null;

  const write = (text: string) => {
    if (atLineStart) out.push(INDENT.repeat(depth));
    out.push(text);
    atLineStart = false;
  };

  const newline = (count = 1) => {
    for (let i = 0; i < count; i += 1) out.push('\n');
    atLineStart = true;
  };

  for (const token of tokens) {
    if (token.kind === 'eof') break;

    /* A closing brace un-indents *before* it is written, so it lines up with the line that opened
       the block rather than with the block's contents. */
    if (token.text === '}' && token.kind === 'punct') depth = Math.max(0, depth - 1);

    if (previous !== null) {
      const breaks = breaksBetween(source, previous.end, token.start);
      if (breaks > 0) {
        /*
         * At most one blank line survives, and that is what makes formatting idempotent.
         *
         * Preserving every blank line would be stable too, but a file drifts towards more of them
         * and no rule ever pushes back. Collapsing to one is a fixed point: two become one, one
         * stays one.
         */
        newline(Math.min(breaks, 2));
      } else if (needsSpace(previous, token)) {
        write(' ');
      }
    }

    write(token.text);

    if (token.kind === 'punct' && token.text === '{') depth += 1;

    previous = token;
  }

  newline();

  /* A trailing blank line is not information. Collapsing here rather than in the loop keeps the
     newline rule in one place, and is what makes a file ending in blank lines a fixed point. */
  return { text: `${out.join('').replace(/\n+$/, '')}\n`, diagnostics: [] };
}

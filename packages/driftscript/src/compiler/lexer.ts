/**
 * Source text to tokens, reporting rather than throwing.
 *
 * Hand-written rather than generated, for the reason a hand-written scanner is usually right: the
 * grammar is small and fixed, and a generator would be a build step this repository does not have.
 * The one thing that *is* generated points the other way — the TextMate grammar reads
 * `tokens.ts` — which is the direction that makes drift impossible rather than merely unlikely.
 *
 * **A lexical error is a diagnostic, and scanning continues past it.** A file with two stray
 * characters reports two, because a user who fixes one at a time fixes a file in as many rounds as
 * it has mistakes. The cost is that a badly mangled file produces a cascade; what would make it
 * wrong is a recovery so eager that the parser downstream sees a token stream nobody wrote, which
 * is why recovery here is one character wide and nothing more.
 */
import type { Diagnostic } from './diagnostics.ts';
import { PUNCTUATION, UNIT_SUFFIXES, isKeyword } from './tokens.ts';

export type TokenKind =
  | 'keyword'
  | 'ident'
  | 'number'
  | 'unit'
  | 'string'
  | 'punct'
  | 'annotation'
  | 'comment'
  | 'eof';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /** Byte offset into the source, inclusive. */
  readonly start: number;
  /** Byte offset into the source, exclusive. */
  readonly end: number;
}

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);

/**
 * Scan `source` into tokens.
 *
 * `file` names the source in any diagnostic produced. It defaults rather than being required
 * because most lexer tests care about tokens and not about filenames, and a required argument
 * every caller passes the same placeholder to is a required argument nobody reads.
 */
export function tokenize(source: string, file = '<anonymous>'): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let i = 0;

  const push = (kind: TokenKind, start: number, end: number) => {
    tokens.push({ kind, text: source.slice(start, end), start, end });
  };

  const report = (
    code: Diagnostic['code'],
    message: string,
    start: number,
    end: number,
  ) => {
    diagnostics.push({ code, severity: 'error', message, file, start, end });
  };

  while (i < source.length) {
    const c = source[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i += 1;
      continue;
    }

    if (c === '/' && source[i + 1] === '/') {
      const start = i;
      while (i < source.length && source[i] !== '\n') i += 1;
      push('comment', start, i);
      continue;
    }

    if (c === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        report('DS0002', 'unterminated block comment', start, source.length);
      }
      push('comment', start, i);
      continue;
    }

    if (c === '"') {
      const start = i;
      i += 1;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i += 1;
          closed = true;
          break;
        }
        /*
         * A newline ends the search rather than being swallowed.
         *
         * A missing closing quote would otherwise consume the rest of the file and report one
         * error at the end of it, which is the least useful place to point. Stopping at the line
         * end puts the caret where the string was opened. There are no multi-line string literals
         * for exactly this reason; if one is ever wanted it gets its own delimiter.
         */
        if (source[i] === '\n') break;
        i += 1;
      }
      if (!closed) {
        report('DS0001', 'unterminated string literal', start, i);
      }
      push('string', start, i);
      continue;
    }

    if (c === '@') {
      const start = i;
      i += 1;
      while (i < source.length && isIdentPart(source[i])) i += 1;
      if (i === start + 1) {
        report('DS0003', 'unexpected character `@` with no annotation name after it', start, i);
        continue;
      }
      push('annotation', start, i);
      continue;
    }

    if (isDigit(c)) {
      const start = i;
      while (i < source.length && isDigit(source[i])) i += 1;
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i += 1;
        while (i < source.length && isDigit(source[i])) i += 1;
      }
      push('number', start, i);

      /*
       * A unit suffix is its own token, immediately after the number and with no space allowed.
       *
       * Splitting it here rather than in the parser is what stops `30m` lexing as an identifier
       * `m` that happens to follow a number — which would parse as two expressions and produce a
       * syntax error three tokens later, pointing nowhere near the cause.
       *
       * `UNIT_SUFFIXES` is ordered longest-first so `250ms` finds `ms` rather than `m` followed by
       * a stray `s`. The suffix must not be followed by an identifier character, or `30media`
       * would lex as `30`, `m`, `edia`.
       */
      for (const suffix of UNIT_SUFFIXES) {
        if (!source.startsWith(suffix, i)) continue;
        const after = source[i + suffix.length];
        if (after !== undefined && isIdentPart(after)) continue;
        push('unit', i, i + suffix.length);
        i += suffix.length;
        break;
      }
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i])) i += 1;
      /*
       * Matched as an identifier first, then checked against the keyword set.
       *
       * The other order — testing each keyword as a prefix — lexes `f32x` as the keyword `f32`
       * followed by the identifier `x`, and `letter` as `let` followed by `ter`. Both parse
       * without error into something nobody wrote.
       */
      push(isKeyword(source.slice(start, i)) ? 'keyword' : 'ident', start, i);
      continue;
    }

    const punct = PUNCTUATION.find((p) => source.startsWith(p, i));
    if (punct !== undefined) {
      push('punct', i, i + punct.length);
      i += punct.length;
      continue;
    }

    report('DS0003', `unexpected character \`${c}\``, i, i + 1);
    i += 1;
  }

  tokens.push({ kind: 'eof', text: '', start: source.length, end: source.length });
  return { tokens, diagnostics };
}

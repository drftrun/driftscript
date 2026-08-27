/**
 * `degC` where a difference belongs, refused before it becomes a plausible wrong number.
 *
 * **Celsius is an offset scale, and that is the whole of it.** Every other unit in this language is
 * a multiplication, so `250ms` and `0.25` are the same value whether the number is a duration or a
 * difference between two of them. `degC` is not: `20degC` is 293.15 K, correctly, and `5degC` meant
 * as *five degrees warmer* erases to 278.15 — wrong by 273.15, in a program that compiles, runs and
 * produces a number a reader will believe.
 *
 * **A `+` or a `-` is where a value is being combined rather than stated**, and nothing the compiler
 * can see distinguishes "an absolute temperature being subtracted" from "a delta". `t - 20degC` is
 * arithmetically right and `t - 5degC` is arithmetically wrong, and they are the same expression
 * shape with a different number in it. So both are refused and the diagnostic says what to write:
 * `K`, which is numerically identical because a kelvin and a degree Celsius are the same size.
 *
 * **What it costs** is the legitimate `t - 20degC`, which becomes `t - 293.15K`. That is the right
 * trade: the refused spelling is the one that fails silently, and a compiler should spend its
 * refusals where a mistake would otherwise be invisible.
 *
 * `§20.6` of the chemistry design is the argument, written before any of this existed.
 */
import type { Expr, Module, Span } from '../ast.ts';
import type { Diagnostic } from '../diagnostics.ts';

/** The one suffix in the language that is an offset rather than a scale. */
const OFFSET_UNIT = 'degC';

/**
 * A `degC` literal, directly or behind the negation that does not change what it is.
 *
 * Parentheses leave no node, so `-(5degC)` and `-5degC` reach here the same way.
 */
function offsetLiteral(node: Expr): boolean {
  if (node.kind === 'number') return node.unit === OFFSET_UNIT;
  if (node.kind === 'unary') return offsetLiteral(node.operand);
  return false;
}

/**
 * A **generic** walk rather than a switch over every node kind, and that is deliberate.
 *
 * A hand-written walker over forty-odd kinds is a list of the places this rule applies, and the day
 * somebody adds a kind that can hold an expression the rule silently stops applying there. That is
 * precisely the failure this refusal exists to prevent — a wrong number nobody is told about — so
 * the traversal is structural: anything with a `kind` is a node, anything else that is an object or
 * an array is walked into. It costs one pass over the tree at compile time and cannot go stale.
 */
export function checkUnits(module: Module, file: string): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const report = (span: Span): void => {
    diagnostics.push({
      code: 'DS0298',
      severity: 'error',
      message:
        '`degC` is an offset scale, so it may not be added to or subtracted from. Written here it ' +
        'erases to a kelvin value 273.15 too large for a difference. Write the difference in `K` — ' +
        'a kelvin and a degree Celsius are the same size, so the number does not change.',
      file,
      start: span.start,
      end: span.end,
    });
  };

  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    const record = node as Record<string, unknown>;
    if (record.kind === 'binary' && (record.op === '+' || record.op === '-')) {
      for (const side of [record.left, record.right]) {
        const operand = side as Expr | undefined;
        if (operand !== undefined && typeof operand === 'object' && offsetLiteral(operand)) {
          report(operand.span);
        }
      }
    }
    for (const value of Object.values(record)) walk(value);
  };

  walk(module.decls);
  return diagnostics;
}

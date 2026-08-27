import { describe, expect, it } from 'vitest';
import { formatDiagnostic, positionAt } from './diagnostics.ts';

describe('diagnostics', () => {
  it('numbers lines and columns from one, the way an editor does', () => {
    const source = 'data P {\n    phase: f32\n}\n';
    expect(positionAt(source, 0)).toEqual({ line: 1, column: 1 });
    expect(positionAt(source, source.indexOf('phase'))).toEqual({ line: 2, column: 5 });
  });

  it('formats a diagnostic as file:line:column code message', () => {
    const source = 'data P {\n    phase: f32\n}\n';
    const text = formatDiagnostic(
      {
        code: 'DS0301',
        severity: 'error',
        message: 'drift/animation is not provided by target web-min',
        file: 'pulse.drs',
        start: source.indexOf('phase'),
        end: source.indexOf('phase') + 5,
      },
      source,
    );
    expect(text).toContain('pulse.drs:2:5');
    expect(text).toContain('DS0301');
    expect(text).toContain('drift/animation');
  });

  it('places a caret under the span, not beside it', () => {
    const source = 'let a = 1\nlet b = 2\n';
    const text = formatDiagnostic(
      { code: 'DS0002', severity: 'error', message: 'x', file: 'f.drs', start: 14, end: 15 },
      source,
    );
    const lines = text.split('\n');
    const caretLine = lines.find((l) => l.includes('^'));
    const sourceLine = lines.find((l) => l.includes('let b'));
    expect(caretLine!.indexOf('^')).toBe(sourceLine!.indexOf('b'));
  });

  it('draws the caret across the whole span, so a wide error is visibly wide', () => {
    const source = 'let alertness = 1\n';
    const text = formatDiagnostic(
      { code: 'DS0002', severity: 'error', message: 'x', file: 'f.drs', start: 4, end: 13 },
      source,
    );
    const caretLine = text.split('\n').find((l) => l.includes('^'))!;
    expect(caretLine.trim()).toBe('^'.repeat(9));
  });

  it('handles a span at the very end of a source with no trailing newline', () => {
    const source = 'let a = 1';
    expect(() =>
      formatDiagnostic(
        { code: 'DS0002', severity: 'error', message: 'x', file: 'f.drs', start: 9, end: 9 },
        source,
      ),
    ).not.toThrow();
    expect(positionAt(source, 9)).toEqual({ line: 1, column: 10 });
  });
});

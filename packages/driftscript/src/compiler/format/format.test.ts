import { describe, expect, it } from 'vitest';
import { format } from './format.ts';
import { parse } from '../parser.ts';
import { check } from '../check/checker.ts';
import { lower } from '../ir/lower.ts';

/**
 * The formatter, and the one property that matters more than any layout rule.
 *
 * A formatter that changes what a program means is worse than no formatter, because nobody reviews
 * a whitespace diff. `a +% b` reflowed to `a + b` is a silent change to overflow behaviour; `250ms`
 * rewritten as `0.25` is a change to what the source says even though the compiled result agrees.
 *
 * So semantics are asserted structurally: lower both versions and compare the IR with spans
 * stripped. Spans are exactly what formatting is allowed to move, which is why they are the only
 * thing removed.
 */

/** The IR of a source, with every span removed — what must survive formatting unchanged. */
const semantics = (source: string): unknown => {
  const { module } = parse(source, 'a.drs');
  const ir = lower(module, check(module, 'a.drs'));
  return JSON.parse(
    JSON.stringify(ir, (key, value) => (key === 'span' ? undefined : value)),
  );
};

const PROGRAM = `// A door, and what happens to it.
data Door {
    open: bool = false
    angle: f32 = 0
}

enum Light {
    Red
    Green
}

/* Block comments survive too. */
@deterministic
fn swing(door: mut Door, by: f32) {
    door.angle += by
    if door.angle > 45deg {
        door.open = true
    } else {
        door.open = false
    }
}

fn pick(light: Light) -> bool {
    return match light {
        Red => false
        Green => true
    }
}
`;

describe('the formatter', () => {
  it('is idempotent', () => {
    const once = format(PROGRAM).text;
    expect(format(once).text).toBe(once);
  });

  it('leaves an already-canonical file untouched', () => {
    expect(format(PROGRAM).text).toBe(PROGRAM);
  });

  it('preserves semantics, compared as lowered IR rather than as text', () => {
    const messy =
      'data Door{open:bool=false\nangle:f32=0}\nfn swing(door:mut Door,by:f32){door.angle+=by}\n';
    const formatted = format(messy).text;
    expect(formatted).not.toBe(messy);
    expect(semantics(formatted)).toEqual(semantics(messy));
  });

  it('does not rewrite a wrapping operator into a checked one', () => {
    const source = 'fn f(a: u8, b: u8) -> u8 {\n    return a +% b\n}\n';
    const formatted = format(source).text;
    expect(formatted).toContain('+%');
    expect(semantics(formatted)).toEqual(semantics(source));
  });

  it('does not rewrite a unit literal into its erased value', () => {
    const source = 'fn f() -> f32 {\n    return 250ms\n}\n';
    expect(format(source).text).toContain('250ms');
  });

  it('does not expand a compound assignment', () => {
    const source =
      'data P {\n    a: f32 = 0\n}\n\nfn f(p: mut P, dt: f32) {\n    p.a += dt\n}\n';
    expect(format(source).text).toContain('+=');
  });

  it('keeps a unit attached to its number', () => {
    expect(format('fn f() -> f32 {\n    return 30m\n}\n').text).toContain('30m');
  });

  it('indents nested blocks by four spaces a level', () => {
    const formatted = format(
      'fn f(n: f32) -> f32 {\nif n > 0 {\nreturn 1\n}\nreturn 0\n}\n',
    ).text;
    expect(formatted).toContain('    if n > 0 {');
    expect(formatted).toContain('        return 1');
    expect(formatted).toContain('    }');
  });

  it('keeps comments, in the place they were written', () => {
    const formatted = format(PROGRAM).text;
    expect(formatted).toContain('// A door, and what happens to it.');
    expect(formatted).toContain('/* Block comments survive too. */');
    /* The leading comment is still the first line, not moved below the declaration it describes. */
    expect(formatted.split('\n')[0]).toBe('// A door, and what happens to it.');
  });

  it('keeps an annotation on its own line above the declaration', () => {
    const formatted = format(PROGRAM).text;
    const lines = formatted.split('\n');
    const at = lines.findIndex((l) => l.trim() === '@deterministic');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toContain('fn swing');
  });

  it('collapses runs of blank lines to one, which is what makes it a fixed point', () => {
    const source = 'fn a() {\n}\n\n\n\n\nfn b() {\n}\n';
    const once = format(source).text;
    expect(once).not.toContain('\n\n\n');
    expect(format(once).text).toBe(once);
  });

  it('ends with exactly one newline, however the input ended', () => {
    for (const source of ['fn a() {\n}', 'fn a() {\n}\n', 'fn a() {\n}\n\n\n']) {
      const text = format(source).text;
      expect(text.endsWith('}\n')).toBe(true);
    }
  });

  it('returns a file with a syntax error unchanged, with its diagnostics', () => {
    const broken = 'data P {\n    a: f32\n';
    const result = format(broken);
    expect(result.text).toBe(broken);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('formats every corpus and example file to a fixed point', async () => {
    const sources = {
      ...import.meta.glob('../../../examples/*.drs', {
        query: '?raw',
        import: 'default',
        eager: true,
      }),
      ...import.meta.glob('../../../../../docs/corpus/*.drs', {
        query: '?raw',
        import: 'default',
        eager: true,
      }),
    };

    const entries = Object.entries(sources);
    expect(entries.length).toBeGreaterThanOrEqual(9);

    for (const [path, source] of entries) {
      const once = format(source as string).text;
      expect(format(once).text, `${path} is not a fixed point`).toBe(once);
      expect(semantics(once), `${path} changed meaning`).toEqual(semantics(source as string));
    }
  });
});

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

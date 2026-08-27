import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost} from './index.ts';

/**
 * The strict core, end to end: source in, running JavaScript out.
 *
 * These go through `compileDriftScript` and then *run* the result rather than inspecting it,
 * because the properties under test are semantic. A test that greps generated code for
 * `Math.fround` passes on a comment; one that computes `0.1 + 0.2` in single precision and compares
 * cannot.
 */

const compile = (source: string, filename = 'a.drs') =>
  compileDriftScript(source, { filename, host: singleFileHost(), mode: 'development' });

const run = async (source: string) => {
  const result = compile(source);
  if (result.diagnostics.length > 0) {
    throw new Error(
      `expected a clean compile, got:\n${result.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n')}`,
    );
  }
  return (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
  )) as Record<string, (...args: never[]) => unknown>;
};

const codesOf = (source: string) => compile(source).diagnostics.map((d) => d.code);

describe('expressions', () => {
  it('applies precedence rather than left-to-right', async () => {
    const mod = await run('fn f() -> f32 {\n    return 2 + 3 * 4\n}\n');
    expect(mod.f()).toBe(14);
  });

  it('honours parentheses over precedence', async () => {
    const mod = await run('fn f() -> f32 {\n    return (2 + 3) * 4\n}\n');
    expect(mod.f()).toBe(20);
  });

  it('gives comparison a looser precedence than arithmetic', async () => {
    const mod = await run('fn f() -> bool {\n    return 1 + 1 == 2\n}\n');
    expect(mod.f()).toBe(true);
  });

  it('gives `&&` a looser precedence than comparison', async () => {
    const mod = await run('fn f() -> bool {\n    return 1 < 2 && 3 < 4\n}\n');
    expect(mod.f()).toBe(true);
  });

  it('applies unary minus and negation', async () => {
    const mod = await run('fn f() -> f32 {\n    return -3 + 5\n}\n');
    expect(mod.f()).toBe(2);
    const g = await run('fn f() -> bool {\n    return !false\n}\n');
    expect(g.f()).toBe(true);
  });

  it('calls a function declared later in the file', async () => {
    const mod = await run(
      'fn f() -> f32 {\n    return double(21)\n}\n\nfn double(n: f32) -> f32 {\n    return n + n\n}\n',
    );
    expect(mod.f()).toBe(42);
  });

  it('refuses truthiness, because there is none', () => {
    expect(codesOf('fn f(n: f32) {\n    if n {\n    }\n}\n')).toContain('DS0255');
  });

  it('refuses comparing two different types', () => {
    expect(codesOf('fn f(a: f32, b: String) -> bool {\n    return a == b\n}\n')).toContain('DS0258');
  });

  it('refuses arithmetic between two integer widths, naming the three conversions', () => {
    const result = compile('fn f(a: u8, b: u32) -> u32 {\n    return a + b\n}\n');
    expect(result.diagnostics[0].code).toBe('DS0230');
    for (const spelling of ['checked', 'clamp', 'wrap']) {
      expect(result.diagnostics[0].message).toContain(spelling);
    }
  });
});

describe('statements', () => {
  it('binds a `let` and reads it back', async () => {
    const mod = await run('fn f() -> f32 {\n    let a = 2\n    let b = 3\n    return a * b\n}\n');
    expect(mod.f()).toBe(6);
  });

  it('refuses reassigning a `let`', () => {
    expect(codesOf('fn f() -> f32 {\n    let a = 1\n    a = 2\n    return a\n}\n')).toContain('DS0201');
  });

  it('allows reassigning a `var`', async () => {
    const mod = await run('fn f() -> f32 {\n    var a = 1\n    a = 2\n    return a\n}\n');
    expect(mod.f()).toBe(2);
  });

  it('runs an if/else', async () => {
    const source =
      'fn f(n: f32) -> f32 {\n    if n < 0 {\n        return 0\n    } else {\n        return n\n    }\n}\n';
    const mod = await run(source);
    expect(mod.f(-5 as never)).toBe(0);
    expect(mod.f(7 as never)).toBe(7);
  });

  it('chains else if', async () => {
    const source =
      'fn f(n: f32) -> String {\n    if n < 0 {\n        return "negative"\n    } else if n == 0 {\n        return "zero"\n    } else {\n        return "positive"\n    }\n}\n';
    const mod = await run(source);
    expect(mod.f(-1 as never)).toBe('negative');
    expect(mod.f(0 as never)).toBe('zero');
    expect(mod.f(1 as never)).toBe('positive');
  });

  it('runs a while loop', async () => {
    const source =
      'fn f(n: f32) -> f32 {\n    var total = 0\n    var i = 0\n    while i < n {\n        total += i\n        i += 1\n    }\n    return total\n}\n';
    const mod = await run(source);
    expect(mod.f(5 as never)).toBe(10);
  });

  it('scopes a name to the block it was declared in', () => {
    const source =
      'fn f(n: f32) -> f32 {\n    if n > 0 {\n        let inner = 1\n    }\n    return inner\n}\n';
    expect(codesOf(source)).toContain('DS0205');
  });

  it('refuses a function that can finish without returning', () => {
    expect(codesOf('fn f(n: f32) -> f32 {\n    if n > 0 {\n        return 1\n    }\n}\n')).toContain(
      'DS0251',
    );
  });

  it('accepts a function whose branches all return', () => {
    expect(
      codesOf('fn f(n: f32) -> f32 {\n    if n > 0 {\n        return 1\n    } else {\n        return 2\n    }\n}\n'),
    ).toEqual([]);
  });
});

describe('records', () => {
  it('constructs a record literal and reads a field', async () => {
    const source =
      'data P {\n    a: f32 = 0\n    b: f32 = 0\n}\n\nfn f() -> f32 {\n    let p = P { a: 3, b: 4 }\n    return p.a + p.b\n}\n';
    const mod = await run(source);
    expect(mod.f()).toBe(7);
  });

  it('refuses a record literal that leaves a field out', () => {
    const source = 'data P {\n    a: f32 = 0\n    b: f32 = 0\n}\n\nfn f() -> P {\n    return P { a: 1 }\n}\n';
    expect(codesOf(source)).toContain('DS0228');
  });

  it('tells a record literal from an if condition and its block', async () => {
    /* `if door { … }` is the classic ambiguity: an identifier followed by a brace. A condition
       suppresses record literals, so this parses as a condition and its body. */
    const source =
      'fn f(open: bool) -> f32 {\n    if open {\n        return 1\n    }\n    return 0\n}\n';
    const mod = await run(source);
    expect(mod.f(true as never)).toBe(1);
    expect(mod.f(false as never)).toBe(0);
  });
});

describe('enums and match', () => {
  const TRAFFIC = 'enum Light {\n    Red\n    Amber\n    Green\n}\n';

  it('matches every variant of an enum', async () => {
    const source = `${TRAFFIC}\nfn go(l: Light) -> bool {\n    return match l {\n        Red => false\n        Amber => false\n        Green => true\n    }\n}\n`;
    const mod = await run(source);
    const light = (await run(source)).Light as unknown as Record<string, unknown>;
    expect(mod.go(light.Green as never)).toBe(true);
    expect(mod.go(light.Red as never)).toBe(false);
  });

  it('refuses a match that misses a variant, and names it', () => {
    const source = `${TRAFFIC}\nfn go(l: Light) -> bool {\n    return match l {\n        Red => false\n        Green => true\n    }\n}\n`;
    const result = compile(source);
    expect(result.diagnostics[0].code).toBe('DS0210');
    expect(result.diagnostics[0].message).toContain('Amber');
  });

  it('accepts a wildcard in place of the remaining variants', () => {
    const source = `${TRAFFIC}\nfn go(l: Light) -> bool {\n    return match l {\n        Green => true\n        _ => false\n    }\n}\n`;
    expect(codesOf(source)).toEqual([]);
  });

  it('refuses a variant the enum does not have', () => {
    const source = `${TRAFFIC}\nfn go(l: Light) -> bool {\n    return match l {\n        Blue => true\n        _ => false\n    }\n}\n`;
    expect(codesOf(source)).toContain('DS0216');
  });

  it('refuses arms of different types', () => {
    const source = `${TRAFFIC}\nfn go(l: Light) -> bool {\n    return match l {\n        Red => 1\n        _ => true\n    }\n}\n`;
    expect(codesOf(source)).toContain('DS0215');
  });

  it('binds a payload and uses it', async () => {
    const source =
      'enum Shape {\n    Dot\n    Circle(f32)\n}\n\nfn area(s: Shape) -> f32 {\n    return match s {\n        Dot => 0\n        Circle(r) => r * r\n    }\n}\n';
    const mod = await run(source);
    const shape = (mod as unknown as { Shape: Record<string, unknown> }).Shape;
    expect(mod.area((shape.Circle as (v: number) => unknown)(3) as never)).toBe(9);
    expect(mod.area(shape.Dot as never)).toBe(0);
  });
});

describe('options', () => {
  it('refuses using an option where its inner type is expected', () => {
    const source = 'fn f(a: f32?) -> f32 {\n    return a\n}\n';
    expect(codesOf(source)).toContain('DS0254');
  });

  it('refuses assigning a bare value to an option, because that is implicit null again', () => {
    expect(codesOf('fn f() -> f32? {\n    return 1\n}\n')).toContain('DS0254');
  });

  it('wraps with `some` and unwraps with `if let`', async () => {
    const source =
      'fn wrap(n: f32) -> f32? {\n    return some(n)\n}\n\nfn read(a: f32?) -> f32 {\n    if let v = a {\n        return v\n    } else {\n        return 0\n    }\n}\n';
    const mod = await run(source);
    expect(mod.read(mod.wrap(7 as never) as never)).toBe(7);
  });

  it('takes `none` from the context that gives it a type', async () => {
    const source =
      'fn empty() -> f32? {\n    return none\n}\n\nfn read(a: f32?) -> f32 {\n    if let v = a {\n        return v\n    } else {\n        return -1\n    }\n}\n';
    const mod = await run(source);
    expect(mod.read(mod.empty() as never)).toBe(-1);
  });

  it('refuses a bare `none` with no context to type it', () => {
    expect(codesOf('fn f() {\n    let a = none\n}\n')).toContain('DS0224');
  });

  it('keeps `?.` an option, so the conditional operation is not treated as unconditional', () => {
    const source =
      'data P {\n    a: f32 = 0\n}\n\nfn f(p: P?) -> f32 {\n    return p?.a\n}\n';
    /* `p?.a` is `f32?`, not `f32` — reading it needs `if let`, which is the whole point. */
    expect(codesOf(source)).toContain('DS0254');
  });

  it('refuses `?.` on something that is not an option', () => {
    const source = 'data P {\n    a: f32 = 0\n}\n\nfn f(p: P) -> f32? {\n    return p?.a\n}\n';
    expect(codesOf(source)).toContain('DS0225');
  });
});

describe('results', () => {
  const LOAD =
    'enum LoadError {\n    Missing\n    Corrupt\n}\n\nfn load(ok: bool) -> Result<f32, LoadError> {\n    if ok {\n        return Ok(1)\n    } else {\n        return Err(LoadError.Missing)\n    }\n}\n';

  it('constructs and matches a result', async () => {
    const source = `${LOAD}\nfn use(ok: bool) -> f32 {\n    return match load(ok) {\n        Ok(v) => v\n        Err(e) => -1\n    }\n}\n`;
    const mod = await run(source);
    expect(mod.use(true as never)).toBe(1);
    expect(mod.use(false as never)).toBe(-1);
  });

  it('propagates with `?` and returns the value on success', async () => {
    const source = `${LOAD}\nfn chain(ok: bool) -> Result<f32, LoadError> {\n    let v = load(ok)?\n    return Ok(v + 10)\n}\n`;
    const mod = await run(source);
    expect(mod.chain(true as never)).toEqual({ tag: 'Ok', value: 11 });
  });

  it('propagates with `?` and returns the failure unchanged', async () => {
    const source = `${LOAD}\nfn chain(ok: bool) -> Result<f32, LoadError> {\n    let v = load(ok)?\n    return Ok(v + 10)\n}\n`;
    const mod = await run(source);
    expect(mod.chain(false as never)).toMatchObject({ tag: 'Err' });
  });

  it('refuses `?` in a function that does not return a Result', () => {
    const source = `${LOAD}\nfn chain(ok: bool) -> f32 {\n    let v = load(ok)?\n    return v\n}\n`;
    expect(codesOf(source)).toContain('DS0211');
  });

  it('refuses a match on a result that misses a case', () => {
    const source = `${LOAD}\nfn use(ok: bool) -> f32 {\n    return match load(ok) {\n        Ok(v) => v\n    }\n}\n`;
    expect(codesOf(source)).toContain('DS0210');
  });

  it('refuses `Ok` with no context to give it an error type', () => {
    expect(codesOf('fn f() {\n    let a = Ok(1)\n}\n')).toContain('DS0226');
  });

  it('keeps two results with different error types apart', () => {
    const source =
      'enum A {\n    X\n}\n\nenum B {\n    Y\n}\n\nfn a() -> Result<f32, A> {\n    return Ok(1)\n}\n\nfn b() -> Result<f32, B> {\n    return a()\n}\n';
    expect(codesOf(source)).toContain('DS0254');
  });
});

describe('integers and overflow', () => {
  it('accepts a literal that fits the declared width', async () => {
    const mod = await run('fn f() -> u8 {\n    return 200\n}\n');
    expect(mod.f()).toBe(200);
  });

  it('throws on a checked overflow rather than producing a value outside the type', async () => {
    const mod = await run('fn f(a: u8, b: u8) -> u8 {\n    return a + b\n}\n');
    expect(() => mod.f(200 as never, 100 as never)).toThrow(/overflow/);
  });

  it('wraps with `+%`', async () => {
    const mod = await run('fn f(a: u8, b: u8) -> u8 {\n    return a +% b\n}\n');
    expect(mod.f(200 as never, 100 as never)).toBe(44);
  });

  it('saturates with `+|`', async () => {
    const mod = await run('fn f(a: u8, b: u8) -> u8 {\n    return a +| b\n}\n');
    expect(mod.f(200 as never, 100 as never)).toBe(255);
  });

  it('wraps a signed integer into its own range', async () => {
    const mod = await run('fn f(a: i8, b: i8) -> i8 {\n    return a +% b\n}\n');
    expect(mod.f(120 as never, 10 as never)).toBe(-126);
  });

  it('refuses wrapping arithmetic on a float, rather than treating it as a synonym', () => {
    expect(codesOf('fn f(a: f32, b: f32) -> f32 {\n    return a +% b\n}\n')).toContain('DS0231');
  });

  it('rounds f32 arithmetic at each operation, the way single precision actually behaves', async () => {
    const mod = await run('fn f(a: f32, b: f32) -> f32 {\n    return a + b\n}\n');
    expect(mod.f(0.1 as never, 0.2 as never)).toBe(Math.fround(0.1 + 0.2));
  });
});

describe('conversions', () => {
  it('clamps a value that does not fit', async () => {
    const mod = await run('fn f(n: f32) -> u8 {\n    return u8.clamp(n)\n}\n');
    expect(mod.f(300 as never)).toBe(255);
    expect(mod.f(-5 as never)).toBe(0);
    expect(mod.f(42 as never)).toBe(42);
  });

  it('wraps a value that does not fit', async () => {
    const mod = await run('fn f(n: f32) -> u8 {\n    return u8.wrap(n)\n}\n');
    expect(mod.f(300 as never)).toBe(44);
  });

  it('yields an option from `checked`, absent when the value does not fit', async () => {
    const source =
      'fn narrow(n: f32) -> u8? {\n    return u8.checked(n)\n}\n\nfn or(n: f32, fallback: u8) -> u8 {\n    if let v = u8.checked(n) {\n        return v\n    } else {\n        return fallback\n    }\n}\n';
    const mod = await run(source);
    expect(mod.narrow(42 as never)).toEqual({ tag: 'some', value: 42 });
    expect(mod.narrow(300 as never)).toEqual({ tag: 'none' });
    expect(mod.or(300 as never, 9 as never)).toBe(9);
  });

  it('propagates a failed `checked` with `?`', async () => {
    const source =
      'fn narrow(n: f32) -> u8? {\n    let v = u8.checked(n)?\n    return some(v)\n}\n';
    const mod = await run(source);
    expect(mod.narrow(7 as never)).toEqual({ tag: 'some', value: 7 });
    expect(mod.narrow(999 as never)).toEqual({ tag: 'none' });
  });

  it('clamps a signed integer into its own range', async () => {
    const mod = await run('fn f(n: f32) -> i8 {\n    return i8.clamp(n)\n}\n');
    expect(mod.f(300 as never)).toBe(127);
    expect(mod.f(-300 as never)).toBe(-128);
  });

  it('refuses a conversion on a float type', () => {
    expect(codesOf('fn f(n: f32) -> f32 {\n    return f32.clamp(n)\n}\n')).toContain('DS0232');
  });

  it('refuses a conversion nobody defined, and names the three that exist', () => {
    const result = compile('fn f(n: f32) -> u8 {\n    return u8.round(n)\n}\n');
    expect(result.diagnostics[0].code).toBe('DS0233');
    for (const spelling of ['checked', 'clamp', 'wrap']) {
      expect(result.diagnostics[0].message).toContain(spelling);
    }
  });

  it('refuses converting something that is not a number', () => {
    expect(codesOf('fn f(s: String) -> u8 {\n    return u8.clamp(s)\n}\n')).toContain('DS0234');
  });
});

describe('units, erased', () => {
  it('converts a duration to the base unit and leaves a bare number', async () => {
    const mod = await run('fn f() -> f32 {\n    return 250ms\n}\n');
    expect(mod.f()).toBeCloseTo(0.25, 12);
    expect(typeof mod.f()).toBe('number');
  });

  it('converts an angle at the literal', async () => {
    const mod = await run('fn f() -> f32 {\n    return 90deg\n}\n');
    expect(mod.f()).toBeCloseTo(Math.PI / 2, 6);
  });

  it('leaves no unit tag anywhere in the generated module', () => {
    const { code } = compile('fn f() -> f32 {\n    return 30m\n}\n');
    for (const trace of ['unit', "'m'", '"m"']) {
      expect(code).not.toContain(trace);
    }
  });
});

describe('generated code', () => {
  it('carries no Node assumptions', () => {
    const { code } = compile(
      'data P {\n    a: f32 = 0\n}\n\nfn f(p: mut P, dt: f32) {\n    p.a += dt\n}\n',
    );
    for (const forbidden of ['require(', 'process.', '__dirname', 'Buffer', 'node:']) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('emits integer helpers only into a module that uses them', () => {
    expect(compile('fn f(a: f32, b: f32) -> f32 {\n    return a + b\n}\n').code).not.toContain(
      '$chk',
    );
    expect(compile('fn f(a: u8, b: u8) -> u8 {\n    return a + b\n}\n').code).toContain('$chk');
  });

  it('keeps source maps correct after helpers are prepended', async () => {
    const source = 'fn f(a: u8, b: u8) -> u8 {\n    return a + b\n}\n';
    const { code, map } = compile(source);
    const { SourceMapConsumer } = await import('source-map-js');
    const consumer = new SourceMapConsumer(map as never);

    const lines = code.split('\n');
    const generatedLine = lines.findIndex((l) => l.includes('return $chk')) + 1;
    expect(generatedLine).toBeGreaterThan(0);
    const original = consumer.originalPositionFor({
      line: generatedLine,
      column: lines[generatedLine - 1].indexOf('return'),
    });
    /* `    return a + b` is line 2. A preamble prepended after the mappings were built is exactly
       the off-by-N that makes a map point at plausible but wrong lines. */
    expect(original.line).toBe(2);
  });
});

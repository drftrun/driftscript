import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost} from './index.ts';
import { createRegistry, defineCapability } from '../registry/capability.ts';
import { defineTarget } from '../registry/manifest.ts';

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

  it('refuses an integer conversion on a float, and names the one a float has', () => {
    /* This used to be `DS0232`, "f32 has no conversions" — which was true and was the hole a
       consumer reported: `std/math` is single precision, a generic ECS accessor is double, and the
       compiler's own advice was that nothing could be done about it. */
    const result = compile('fn f(n: f32) -> f32 {\n    return f32.clamp(n)\n}\n');
    expect(result.diagnostics[0].code).toBe('DS0233');
    expect(result.diagnostics[0].message).toContain('nearest');
  });

  it('still refuses a conversion on a type that has none, naming both families', () => {
    const result = compile('fn f(b: bool) -> bool {\n    return bool.nearest(b)\n}\n');
    expect(result.diagnostics[0].code).toBe('DS0232');
    for (const spelling of ['checked', 'clamp', 'wrap', 'nearest']) {
      expect(result.diagnostics[0].message).toContain(spelling);
    }
  });

  it('rounds an f64 to the nearest f32', async () => {
    const mod = await run('fn f(n: f64) -> f32 {\n    return f32.nearest(n)\n}\n');
    expect(mod.f(0.1 as never)).toBe(Math.fround(0.1));
    expect(mod.f(Math.PI as never)).toBe(Math.fround(Math.PI));
    /* Not merely close: the whole point is that it is the f32 a shader would hold. */
    expect(mod.f(Math.PI as never)).not.toBe(Math.PI);
  });

  it('widens an f32 to an f64 exactly, because every f32 is an f64', async () => {
    const mod = await run('fn f(n: f32) -> f64 {\n    return f64.nearest(n)\n}\n');
    const single = Math.fround(0.1);
    expect(mod.f(single as never)).toBe(single);
  });

  it('refuses the widening unwritten, because there is no implicit widening', () => {
    /* The conversion existing does not make it optional. `LANGUAGE.md` promises this in one
       sentence with no exceptions, and an exception for the lossless direction is a promise a
       reader has to keep a list for. */
    expect(codesOf('fn f(n: f32) -> f64 {\n    return n\n}\n')).toContain('DS0254');
    expect(codesOf('fn f(n: f32) {\n    let wide: f64 = n\n}\n')).toContain('DS0208');
  });

  it('names `nearest` when two floats meet in one expression', () => {
    const result = compile('fn f(a: f32, b: f64) -> f64 {\n    return a + b\n}\n');
    expect(result.diagnostics[0].code).toBe('DS0230');
    expect(result.diagnostics[0].message).toContain('nearest');
    /* The integer spellings are absent rather than merely outnumbered: offering `wrap` to somebody
       holding two floats sends them to DS0232, which used to be a dead end. */
    expect(result.diagnostics[0].message).not.toContain('wrap');
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

describe('leaving a loop', () => {
  it('stops the loop on `break`', async () => {
    const mod = await run(
      'fn firstOver(limit: f32) -> f32 {\n' +
        '    var n = 0\n' +
        '    while n < 100 {\n' +
        '        n += 1\n' +
        '        if n >= limit {\n' +
        '            break\n' +
        '        }\n' +
        '    }\n' +
        '    return n\n' +
        '}\n',
    );
    expect(mod.firstOver(7 as never)).toBe(7);
    /* The loop still runs once: `break` leaves at the point it is written, not before the body. */
    expect(mod.firstOver(0 as never)).toBe(1);
  });

  it('skips the rest of the turn on `continue`', async () => {
    const mod = await run(
      'fn sumOdd(upto: f32) -> f32 {\n' +
        '    var n = 0\n' +
        '    var total = 0\n' +
        '    while n < upto {\n' +
        '        n += 1\n' +
        '        if n % 2 == 0 {\n' +
        '            continue\n' +
        '        }\n' +
        '        total += n\n' +
        '    }\n' +
        '    return total\n' +
        '}\n',
    );
    expect(mod.sumOdd(10 as never)).toBe(25);
  });

  it('refuses either word outside a loop, naming the one that was written', () => {
    /* One code for both, because it is one mistake. Two would split a consumer's grep across a
       distinction that changes nothing about what they have to do. */
    const broken = compile('fn f() {\n    break\n}\n');
    expect(broken.diagnostics[0].code).toBe('DS0238');
    expect(broken.diagnostics[0].message).toContain('`break`');
    expect(compile('fn f() {\n    continue\n}\n').diagnostics[0].message).toContain('`continue`');
  });

  it('refuses a jump in a function called from a loop, because that function is not in one', () => {
    /* The loop counter is per body rather than global. A counter that leaked across a call would
       have accepted this, and the generated function would have carried a jump with no loop. */
    const source =
      'fn inner() {\n    break\n}\n\nfn outer() {\n    var n = 0\n    while n < 3 {\n        n += 1\n        inner()\n    }\n}\n';
    expect(codesOf(source)).toContain('DS0238');
  });

  it('leaves the innermost loop, which is the only loop a jump can name', () => {
    /* There are no labels. `break` in a nested loop leaves the inner one and the outer one carries
       on, which is what makes the counter sufficient. */
    const source =
      'fn f() -> f32 {\n' +
        '    var outer = 0\n' +
        '    var hits = 0\n' +
        '    while outer < 3 {\n' +
        '        outer += 1\n' +
        '        var inner = 0\n' +
        '        while inner < 10 {\n' +
        '            inner += 1\n' +
        '            hits += 1\n' +
        '            break\n' +
        '        }\n' +
        '    }\n' +
        '    return hits\n' +
        '}\n';
    expect(codesOf(source)).toEqual([]);
  });
});

describe('a module constant', () => {
  it('is a value the whole file can name, without a function around it', async () => {
    const mod = await run(
      'let SECONDS_PER_HOUR = 3600\n\n' +
        'fn hours(seconds: f32) -> f32 {\n    return seconds / SECONDS_PER_HOUR\n}\n',
    );
    expect(mod.hours(7200 as never)).toBe(2);
  });

  it('may name another constant, in either order', async () => {
    /* Declaration order carries no meaning, which `LANGUAGE.md` promises without exception. It is
       true for a function because a function declaration hoists and a `const` does not, so the
       lowering sorts these into dependency order — see `orderedConstants`. */
    const mod = await run(
      'let SECONDS_PER_HOUR = 60 * MINUTE\n' +
        'let MINUTE = 60\n\n' +
        'fn hours(seconds: f32) -> f32 {\n    return seconds / SECONDS_PER_HOUR\n}\n',
    );
    expect(mod.hours(7200 as never)).toBe(2);
  });

  it('is exported, because a shared number is what it replaces', async () => {
    const mod = await run('let LIMIT = 12\n\nfn f() -> f32 {\n    return LIMIT\n}\n');
    expect((mod as unknown as { LIMIT: number }).LIMIT).toBe(12);
  });

  it('takes a written type, and is checked against it', () => {
    expect(codesOf('let A: f64 = 1\n\nfn f() -> f64 {\n    return A\n}\n')).toEqual([]);
    expect(codesOf('let A: String = 1\n')).toContain('DS0208');
  });

  it('is shadowed by a local of the same name, like any other binding', async () => {
    const mod = await run(
      'let A = 1\n\nfn f() -> f32 {\n    let A = 2\n    return A\n}\n',
    );
    expect(mod.f()).toBe(2);
  });

  it('refuses a cycle, naming every constant in it', () => {
    /* Reported against each, and each names the whole set: a cycle read as one edge sends a reader
       to whichever end the edge happened to point at. */
    const result = compile('let A = B\nlet B = A\n');
    expect(result.diagnostics.every((d) => d.code === 'DS0240')).toBe(true);
    expect(result.diagnostics[0].message).toContain('`A`');
    expect(result.diagnostics[0].message).toContain('`B`');
  });

  it('refuses a call in its value, because a module is evaluated before its host is bound', () => {
    const result = compile('@pure\nfn g() -> f32 {\n    return 1\n}\n\nlet A = g()\n');
    expect(result.diagnostics[0].code).toBe('DS0239');
  });

  it('cannot be written to', () => {
    expect(codesOf('let A = 1\n\nfn f() {\n    A = 2\n}\n')).toContain('DS0241');
  });

  it('refuses `var` at the top of a file, and says why', () => {
    /* Module state is what a hot reload has to migrate and a replay has to restore. The message
       carries that reason, because "expected a declaration" would have named the keyword and not
       the problem. */
    const result = compile('var A = 1\n');
    expect(result.diagnostics[0].code).toBe('DS0137');
    expect(result.diagnostics[0].message).toContain('hot reload');
  });

  it('refuses a name that is already a function', () => {
    expect(codesOf('let A = 1\n\nfn A() -> f32 {\n    return 1\n}\n')).toContain('DS0242');
  });
});

describe('a list', () => {
  it('is indexed, which is what a chain of `if` was standing in for', async () => {
    /* The shape a consumer reported: a twenty-two-line chain of `if` over an index, because there
       was no collection type and `std/collections` was advertised and empty. */
    const mod = await run(
      'fn skyName(index: u32) -> String {\n' +
        '    let names = ["clear", "cloud", "rain", "storm"]\n' +
        '    if index >= len(names) {\n        return "unknown"\n    }\n' +
        '    return names[index]\n}\n',
    );
    expect(mod.skyName(2 as never)).toBe('rain');
    expect(mod.skyName(9 as never)).toBe('unknown');
  });

  it('is walked by `for … in`', async () => {
    const mod = await run(
      'fn total(xs: List<f32>) -> f32 {\n' +
        '    var sum = 0\n    for x in xs {\n        sum += x\n    }\n    return sum\n}\n',
    );
    expect(mod.total([1, 2, 3] as never)).toBe(6);
  });

  it('grows through `push`, and an empty one takes its type from its annotation', async () => {
    const mod = await run(
      'fn grow() -> u32 {\n    var xs: List<f32> = []\n' +
        '    push(xs, 1)\n    push(xs, 2)\n    return len(xs)\n}\n',
    );
    expect(mod.grow()).toBe(2);
  });

  it('throws on an index past the end rather than answering `undefined`', async () => {
    /* The same decision integer overflow got. JavaScript's own answer is `undefined`, which a
       script has no type for: it flows into arithmetic as `NaN` and surfaces frames later,
       somewhere with nothing to do with the read. */
    const mod = await run('fn f(xs: List<f32>, i: u32) -> f32 {\n    return xs[i]\n}\n');
    expect(() => mod.f([1, 2] as never, 5 as never)).toThrow(/outside a list of 2/);
  });

  it('is invariant, which is what keeps record subtyping sound', () => {
    /*
     * **The rule `types.ts` demanded in writing before this existed.** Its note on width subtyping
     * said the soundness argument rested on there being no container, and told whoever added one to
     * write an invariance rule in the same commit. With covariance a `List<Wolf>` passed as a
     * `List<Dog>` could have a plain `Dog` pushed into it, and the caller's next read would find a
     * `Dog` in a list whose type says `Wolf`.
     */
    const source =
      'data Dog {\n    energy: f32 = 1\n}\n\ndata Wolf : Dog {\n    pack: f32 = 1\n}\n\n' +
      'fn take(xs: List<Dog>) -> u32 {\n    return len(xs)\n}\n\n' +
      'fn f(ws: List<Wolf>) -> u32 {\n    return take(ws)\n}\n';
    const result = compile(source);
    expect(result.diagnostics[0]?.code).toBe('DS0263');
    expect(result.diagnostics[0]?.message).toContain('List<Wolf>');
    /* A record still widens; only the container does not. */
    expect(
      codesOf(
        'data Dog {\n    energy: f32 = 1\n}\n\ndata Wolf : Dog {\n    pack: f32 = 1\n}\n\n' +
          'fn take(d: Dog) -> f32 {\n    return d.energy\n}\n\n' +
          'fn f(w: Wolf) -> f32 {\n    return take(w)\n}\n',
      ),
    ).toEqual([]);
  });

  it('refuses an empty list with no type to take, like `none`', () => {
    expect(codesOf('fn f() {\n    let xs = []\n}\n')).toContain('DS0244');
  });

  it('refuses a mixed literal, an index of a non-list, and a walk over one', () => {
    expect(codesOf('fn f() {\n    let xs = [1, "two"]\n}\n')).toContain('DS0245');
    expect(codesOf('fn f(n: f32) -> f32 {\n    return n[0]\n}\n')).toContain('DS0246');
    expect(codesOf('fn f(n: f32) {\n    for x in n {\n    }\n}\n')).toContain('DS0246');
  });

  it('needs `mut` to push, because growing a list writes to the container', () => {
    expect(codesOf('fn f() {\n    let xs = [1]\n    push(xs, 2)\n}\n')).toContain('DS0201');
    expect(codesOf('fn f() {\n    var xs = [1]\n    push(xs, "a")\n}\n')).toContain('DS0245');
  });

  it('leaves a list walk on `break` and skips a turn on `continue`', async () => {
    const mod = await run(
      'fn upTo(xs: List<f32>, limit: f32) -> f32 {\n' +
        '    var sum = 0\n    for x in xs {\n' +
        '        if x < 0 {\n            continue\n        }\n' +
        '        if x > limit {\n            break\n        }\n' +
        '        sum += x\n    }\n    return sum\n}\n',
    );
    expect(mod.upTo([1, -5, 2, 99, 3] as never, 10 as never)).toBe(3);
  });
});

describe('a component reached through a handle', () => {
  /** Compile, then bind a world that records what was read and written. */
  const withWorld = async (source: string) => {
    const result = compile(source);
    expect(result.diagnostics).toEqual([]);
    const mod = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
    )) as Record<string, (...args: never[]) => unknown> & {
      __bind: (host: Record<string, unknown>) => void;
    };
    const store = new Map<string, number>();
    mod.__bind({
      'drift/ecs': {
        read: (_w: unknown, e: number, c: string, f: string) => store.get(`${e}.${c}.${f}`) ?? 0,
        write: (_w: unknown, e: number, c: string, f: string, v: number) => {
          store.set(`${e}.${c}.${f}`, v);
        },
      },
    });
    return { mod, store };
  };

  it('reads and writes through `drift/ecs`, where it used to emit a property of a number', async () => {
    /*
     * **The bug this closes emitted `who.Placement.x = 1` and threw.**
     *
     * A component access resolves to a view and an index inside a query loop. Outside one there was
     * no loop to resolve against, and lowering fell through to an ordinary field access — so the
     * form the checker accepted, the linker passed and the tests exercised for its *inference*
     * produced JavaScript that read a property of a number. Nothing ran it.
     *
     * It is also what a consumer was writing by hand as `ecs.write(world, e, "Placement", "x", x)`,
     * one field at a time, with the component and field as strings a typo could not be caught in.
     */
    const { mod, store } = await withWorld(
      'component Placement {\n    x: f64 = 0\n}\n\n' +
        'fn bump(world: World, who: Entity) -> f64 {\n' +
        '    who.Placement.x = who.Placement.x + 1\n    return who.Placement.x\n}\n',
    );
    expect(mod.bump({} as never, 12345 as never)).toBe(1);
    expect(mod.bump({} as never, 12345 as never)).toBe(2);
    expect(store.get('12345.Placement.x')).toBe(2);
  });

  it('catches the typo the string calls could not', () => {
    /* The cost a consumer named: `"Placement"` and `"x"` are strings, so a misspelling is a runtime
       zero rather than a compile error. Written this way both are checked. */
    const placement = 'component Placement {\n    x: f64 = 0\n}\n\n';
    expect(
      codesOf(`${placement}fn f(world: World, w: Entity) -> f64 {\n    return w.Placement.xx\n}\n`),
    ).toContain('DS0203');
    expect(
      codesOf(`${placement}fn f(world: World, w: Entity) -> f64 {\n    return w.Mets.x\n}\n`),
    ).toContain('DS0286');
  });

  it('needs a world to reach it from, and says so', () => {
    /* The one case that is refused rather than fixed. There is nowhere for `ecs.read` to read
       from, and a helper that wants one takes a `World` parameter — which is what the engine's own
       capabilities have always required. */
    const result = compile(
      'component Placement {\n    x: f64 = 0\n}\n\nfn f(w: Entity) -> f64 {\n    return w.Placement.x\n}\n',
    );
    expect(result.diagnostics[0]?.code).toBe('DS0295');
    expect(result.diagnostics[0]?.message).toContain('World');
  });

  it('pulls in `drift/ecs`, because that is what it compiles to', () => {
    const result = compile(
      'component Placement {\n    x: f64 = 0\n}\n\n' +
        'fn f(world: World, w: Entity) -> f64 {\n    return w.Placement.x\n}\n',
    );
    /* The form is a use of the capability, so the requirement is the module's whether or not the
       file imports anything from it — the same call the query loop makes. */
    expect(result.code).toContain('__bind');
    expect(result.metadata.requires).toContain('drift/ecs');
  });
});

describe('a component row as a parameter', () => {
  const META = 'component Placement {\n    x: f64 = 0\n}\n\n';

  it('lets a helper say which component it touches, and reaches it', async () => {
    /*
     * `fn advance(m: mut Placement, dx: f64)` — the signature names the component, so a reader and the
     * access inference learn it from the same line rather than from the body.
     *
     * A row is not a value: its fields are columns in a world. So the parameter compiles to a world
     * and a handle, and `m.x` inside is the `ecs.read` a handle access already was.
     */
    const result = compile(
      `${META}fn advance(m: mut Placement, dx: f64) {\n    m.x = m.x + dx\n}\n\n` +
        'fn go(world: World, e: Entity) -> f64 {\n' +
        '    advance(e.Placement, 5)\n    advance(e.Placement, 2)\n    return e.Placement.x\n}\n',
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('export function advance(m$world, m, dx)');
    expect(result.code).toContain('advance(world, e, 5)');

    const mod = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
    )) as Record<string, (...args: never[]) => unknown> & {
      __bind: (host: Record<string, unknown>) => void;
    };
    const store = new Map<string, number>();
    mod.__bind({
      'drift/ecs': {
        read: (_w: unknown, e: number, c: string, f: string) => store.get(`${e}.${c}.${f}`) ?? 0,
        write: (_w: unknown, e: number, c: string, f: string, v: number) => {
          store.set(`${e}.${c}.${f}`, v);
        },
      },
    });
    expect(mod.go({} as never, 7 as never)).toBe(7);
  });

  it('needs `mut` to write through, like any other binding', () => {
    expect(codesOf(`${META}fn f(m: Placement) {\n    m.x = 1\n}\n`)).toContain('DS0201');
  });

  it('takes a row of the component it named, and nothing else', () => {
    const other = 'component Other {\n    y: f64 = 0\n}\n\n';
    const helper = 'fn f(m: mut Placement) {\n    m.x = 1\n}\n\n';
    expect(
      codesOf(
        `${META}${other}${helper}fn g(world: World, e: Entity) {\n    f(e.Other)\n}\n`,
      ),
    ).toContain('DS0249');
    /* Not a row at all — the argument is always `entity.Component`, because that is where the
       handle comes from. */
    expect(codesOf(`${META}${helper}fn g(n: f64) {\n    f(n)\n}\n`)).toContain('DS0249');
  });

  it('checks the field name, which is the help the string calls could not give', () => {
    expect(codesOf(`${META}fn f(m: mut Placement) {\n    m.zz = 1\n}\n`)).toContain('DS0203');
  });

  it('is not a value, so it cannot be held or returned', () => {
    /*
     * `entities.ts` had asserted this in a comment since the entity model shipped — "a component is
     * not a value a script can hold" — and nothing enforced it: `let m = w.Placement` compiled to a
     * property read of a number, exactly as `w.Placement.x` did.
     */
    expect(
      codesOf(`${META}fn f(world: World, w: Entity) -> f64 {\n    let m = w.Placement\n    return m.x\n}\n`),
    ).toContain('DS0248');
    expect(
      codesOf(`${META}fn f(world: World, e: Entity) -> f64 {\n    return e.Placement\n}\n`),
    ).toContain('DS0248');
  });
});

describe('a list a capability handed over', () => {
  it('walks and measures a path a host returned', async () => {
    /*
     * The shape a navigation capability has: a polyline as flat pairs. Until a `TypeName` could
     * carry `List<T>` the host's only options were a count-and-index pair of capabilities, or
     * keeping the logic in its own language — which is the thing a script is for.
     */
    const registry = createRegistry();
    registry.addType({ module: 'drift/navigation', name: 'NavMesh', doc: 'A navigation mesh.' });
    registry.add(
      defineCapability({
        module: 'drift/navigation',
        name: 'path',
        signature: 'fn(mesh: NavMesh, x: f32, z: f32) -> List<f32>',
        params: [
          { name: 'mesh', type: 'NavMesh' },
          { name: 'x', type: 'f32' },
          { name: 'z', type: 'f32' },
        ],
        returns: 'List<f32>',
        effects: ['navigation.read'],
        deterministic: true,
        doc: 'A polyline, as flat x/z pairs.',
        implementation: 'Nav.path',
      }),
    );

    const result = compileDriftScript(
      'import { path } from "drift/navigation"\n\n' +
        'fn legs(mesh: NavMesh, x: f32, z: f32) -> f32 {\n' +
        '    let points = navigation.path(mesh, x, z)\n' +
        '    var total = 0\n' +
        '    for p in points {\n        total += p\n    }\n' +
        '    return total\n}\n',
      {
        filename: 'n.drs',
        host: singleFileHost(),
        registry,
        manifest: defineTarget('t', ['drift/navigation']),
        mode: 'development',
      },
    );
    expect(result.diagnostics).toEqual([]);

    const mod = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
    )) as Record<string, (...args: never[]) => unknown> & {
      __bind: (host: Record<string, unknown>) => void;
    };
    mod.__bind({ 'drift/navigation': { path: () => [1, 2, 3, 4] } });
    expect(mod.legs({} as never, 0 as never, 0 as never)).toBe(10);
  });
});


/**
 * Every analysis walks every node, asserted adversarially rather than by feature.
 *
 * **This suite exists because a walk that can quietly not walk is how 1.9.0 shipped five
 * miscompiles.** Nine semantic passes each carried their own recursive `switch` ending in a
 * permissive `default`, so a node kind a pass did not name was skipped in silence — and every one
 * of those programs *compiled clean*. The failures were a `ReferenceError` on a frame local, a
 * module that never declared `$rt`, a `?` that threw its internal carrier out of a function, and
 * two inference passes that let `@deterministic` and a declared-access set pass for code that
 * violated both.
 *
 * The tests below are organised by **nested position** rather than by feature, because the position
 * is what was missed: a list literal, an index, a loop body, a loop subject, a condition, an
 * `ifLet` subject, an event payload, a spawn argument. A feature-shaped suite would have covered
 * every one of these forms at the top level of a function and found nothing.
 *
 * Adding a form to the language means adding a row here. That is the point of the file.
 */
import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from './index.ts';
import { createRegistry, defineCapability } from '../registry/capability.ts';
import { checkEffects } from './check/effects.ts';
import { parse } from './parser.ts';
import { check } from './check/checker.ts';
import { lower } from './ir/lower.ts';
import { hotDiagnostics } from './check/hot.ts';
import { loadModule } from '../runtime/module.ts';

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

/* Spelled out rather than built from a variable: Vite replaces this call by matching it in the
   syntax tree, and a pattern assembled at run time resolves to nothing — a suite that passes
   having read no files. `examples.test.ts` carries the same warning. */
const sources = import.meta.glob('./ir/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** A host with one capability per property a walk has to notice. */
const registry = () => {
  const r = createRegistry();
  r.add(
    defineCapability({
      module: 'drift/audio',
      name: 'play',
      signature: 'fn(gain: f32) -> void',
      params: [{ name: 'gain', type: 'f32' }],
      returns: 'void',
      effects: ['audio.write'],
      deterministic: false,
      doc: 'Play a sound.',
      implementation: 'AudioGraph.play',
    }),
  );
  r.add(
    defineCapability({
      module: 'drift/audio',
      name: 'level',
      signature: 'fn() -> f32',
      params: [],
      returns: 'f32',
      effects: ['audio.write'],
      deterministic: false,
      doc: 'A level, so a forbidden effect can sit in a value position.',
      implementation: 'AudioGraph.level',
    }),
  );
  r.add(
    defineCapability({
      module: 'drift/audio',
      name: 'ready',
      signature: 'fn() -> bool',
      params: [],
      returns: 'bool',
      effects: ['audio.write'],
      deterministic: false,
      doc: 'A bool, so a forbidden effect can sit in a condition.',
      implementation: 'AudioGraph.ready',
    }),
  );
  return r;
};

const compile = (source: string) =>
  compileDriftScript(source, {
    filename: 'w.drs',
    host: singleFileHost(),
    registry: registry(),
    mode: 'development',
  });

/** Compile and insist it is clean, for the tests about what the output *does*. */
const emit = (source: string): string => {
  const { code, diagnostics } = compile(source);
  expect(diagnostics).toEqual([]);
  return code;
};

const load = async (source: string) => {
  const namespace = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${btoa(emit(source))}`
  )) as Record<string, unknown>;
  return loadModule(namespace);
};

const irOf = (source: string) => {
  const parsed = parse(source, 'w.drs');
  expect(parsed.diagnostics).toEqual([]);
  const checked = check(parsed.module, 'w.drs');
  expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return lower(parsed.module, checked, undefined, undefined, undefined, 'w.drs');
};

const hotCodes = (source: string): string[] => {
  const ir = irOf(source);
  const capabilities = new Map([
    ['audio.play', { effects: ['audio.write'] }],
    ['audio.level', { effects: ['audio.write'] }],
    ['audio.ready', { effects: ['audio.write'] }],
  ]);
  return hotDiagnostics(ir, capabilities).map((d) => d.code);
};

const DATA = 'data Tmp {\n    value: f32 = 0\n}\n\n';
const ALLOCATES = 'fn allocates() -> bool {\n    let t = Tmp { value: 0 }\n    return true\n}\n\n';

describe('`@hot` sees an allocation wherever it is written', () => {
  /*
   * A list literal is a JavaScript Array. It emits `[…]` and the design's rule about a per-frame
   * allocation does not care that the source looks like a value — which is the whole reason this
   * analysis runs over the IR rather than the syntax.
   */
  it('reports a list literal', () => {
    expect(hotCodes('@hot\nfn f() -> List<f32> {\n    return [1, 2, 3]\n}\n')).toContain('DS0400');
  });

  it('reports a record literal nested in a list literal', () => {
    expect(
      hotCodes(`${DATA}@hot\nfn f() -> List<Tmp> {\n    return [Tmp { value: 1 }]\n}\n`),
    ).toContain('DS0400');
  });

  it.each([
    ['a `for … in` body', `${DATA}@hot\nfn f(xs: List<f32>) {\n    for x in xs {\n        let t = Tmp { value: x }\n    }\n}\n`],
    ['an `if` condition', `${DATA}${ALLOCATES}@hot\nfn f() {\n    if allocates() {\n    }\n}\n`],
    ['a `while` condition', `${DATA}${ALLOCATES}@hot\nfn f() {\n    while allocates() {\n    }\n}\n`],
    ['an index subscript', `${DATA}fn at() -> u32 {\n    let t = Tmp { value: 0 }\n    return 0\n}\n\n@hot\nfn f(xs: List<f32>) -> f32 {\n    return xs[at()]\n}\n`],
    ['an `ifLet` subject', `${DATA}fn maybe() -> f32? {\n    let t = Tmp { value: 0 }\n    return some(1)\n}\n\n@hot\nfn f() {\n    if let v = maybe() {\n    }\n}\n`],
    ['a spawn argument', `${DATA}fn arg() -> f32 {\n    let t = Tmp { value: 0 }\n    return 1\n}\n\ntask child(v: f32) {\n    await fixedTime(1s)\n}\n\n@hot\nfn f() {\n    spawn child(arg())\n}\n`],
    ['an event payload', `${DATA}event Ping {\n    v: f32 = 0\n}\n\n@hot\nfn f() {\n    emit Ping { v: 1 }\n}\n`],
  ])('reaches %s', (_where, source) => {
    expect(hotCodes(source)).toContain('DS0400');
  });

  it.each([
    ['a `for … in` body', 'fn f(xs: List<f32>) {\n    for x in xs {\n        audio.play(x)\n    }\n}\n'],
    ['an `if` condition', 'fn f() {\n    if audio.ready() {\n    }\n}\n'],
    ['a `while` condition', 'fn f() {\n    while audio.ready() {\n    }\n}\n'],
    ['a list literal', 'fn f() -> List<f32> {\n    return [audio.level()]\n}\n'],
  ])('reports a forbidden capability in %s', (_where, body) => {
    const source = `import { play, level, ready } from "drift/audio"\n\n@hot\n${body}`;
    expect(hotCodes(source)).toContain('DS0401');
  });
});

describe('a task local is read from the frame wherever it is named', () => {
  /*
   * The rewrite that turns a task's bindings into frame fields used to walk expressions with a
   * permissive default, so a local named inside a list literal or an index emitted a bare
   * identifier — code that references a variable no scope declares. It compiled, loaded, and threw
   * on the first resume that reached the line.
   */
  it('rewrites a local read through an index', async () => {
    const module = await load(
      'task run(xs: List<f32>, i: u32) {\n' +
        '    await fixedTime(1s)\n' +
        '    let v = xs[i]\n' +
        '}\n',
    );
    expect(module.exports.run).toBeDefined();
    expect(emit('task run(xs: List<f32>, i: u32) {\n    await fixedTime(1s)\n    let v = xs[i]\n}\n')).toContain(
      '$at($f.$xs, $f.$i)',
    );
  });

  it('rewrites a local read inside a list literal', () => {
    const code = emit('task run(a: f32) {\n    await fixedTime(1s)\n    let ys = [a, a]\n}\n');
    expect(code).toContain('[$f.$a, $f.$a]');
  });

  it('keeps a `let` inside a loop and its reads on the same side of the frame', () => {
    const code = emit(
      'task run(xs: List<f32>) {\n' +
        '    await fixedTime(1s)\n' +
        '    for x in xs {\n' +
        '        let y = x + 1\n' +
        '        let z = y * 2\n' +
        '    }\n' +
        '}\n',
    );
    /* Either both go through the frame or neither does. What must never happen again is the write
       landing on `$f` and the read staying a bare identifier. */
    const writesFrame = code.includes('$f.$y =');
    const readsFrame = code.includes('$f.$y ');
    expect(readsFrame).toBe(writesFrame);
  });
});

describe('the module preamble is emitted for a form wherever it is written', () => {
  /*
   * `usesEmit` decided whether a module declares `$rt` and exports `__runtime`, and it did not walk
   * a `for` loop. An `emit` inside one compiled to a call on a binding the module never declared.
   */
  it('declares `$rt` for an `emit` inside a `for … in`', async () => {
    const source =
      'event Ping {\n    v: f32 = 0\n}\n\n' +
      'fn f(xs: List<f32>) {\n    for x in xs {\n        emit Ping { v: x }\n    }\n}\n';
    expect(emit(source)).toContain('export function __runtime');
    const module = await load(source);
    expect(typeof module.exports.__runtime).toBe('function');
  });

  it('declares `$rt` for an `emit` inside a `while`', () => {
    const source =
      'event Ping {\n    v: f32 = 0\n}\n\n' +
      'fn f(n: u32) {\n    while n > 0 {\n        emit Ping { v: 1 }\n    }\n}\n';
    expect(emit(source)).toContain('export function __runtime');
  });

  /*
   * `usesTry` decided whether a function's body is wrapped in the block that turns the `?` carrier
   * back into an `Err`. Without the wrapper the carrier — an internal object with a `$drift` tag —
   * escapes the function, which is neither the `Err` the signature promises nor anything a caller
   * can act on.
   */
  it('wraps a function whose `?` is inside a `for … in`', async () => {
    const module = await load(
      'fn g(v: f32) -> Result<f32, String> {\n    return Err("no")\n}\n\n' +
        'fn f(xs: List<f32>) -> Result<f32, String> {\n' +
        '    for x in xs {\n' +
        '        let y = g(x)?\n' +
        '    }\n' +
        '    return Ok(0)\n' +
        '}\n',
    );
    const f = module.exports.f as (xs: number[]) => { tag: string; value: unknown };
    expect(f([1])).toEqual({ tag: 'Err', value: 'no' });
  });
});

describe('effect inference reaches every expression position', () => {
  const effectsOf = (body: string): readonly string[] => {
    const source = `import { play, level, ready } from "drift/audio"\n\n${body}`;
    const parsed = parse(source, 'w.drs');
    expect(parsed.diagnostics).toEqual([]);
    const result = checkEffects(parsed.module, registry(), 'w.drs');
    return [...(result.effects.get('f') ?? [])];
  };

  it.each([
    ['a list literal', 'fn f() -> List<f32> {\n    return [audio.level()]\n}\n'],
    ['an index', 'fn f(xs: List<f32>) -> f32 {\n    return xs[u32.checked(audio.level())]\n}\n'],
    ['an `if` condition', 'fn f() {\n    if audio.ready() {\n    }\n}\n'],
    ['a `for … in` body', 'fn f(xs: List<f32>) {\n    for x in xs {\n        audio.play(x)\n    }\n}\n'],
    ['a `while` condition', 'fn f() {\n    while audio.ready() {\n    }\n}\n'],
    ['an event payload', 'event Ping {\n    v: f32 = 0\n}\n\nfn f() {\n    emit Ping { v: audio.level() }\n}\n'],
  ])('sees a capability call in %s', (_where, body) => {
    expect(effectsOf(body)).toContain('audio.write');
  });
});

describe('the walkers are the only place an IR addition has to be handled', () => {
  /*
   * The acceptance criterion the review asked for, as something the suite can actually run: a node
   * this file does not know reaches a refusal that names it, instead of being skipped.
   *
   * A real new kind would be caught at *compile* time by the `never` parameter — which is the point
   * of writing them that way, and which a test cannot observe. This asserts the runtime half, so a
   * node smuggled past the types through a cast still stops rather than disappearing.
   */
  it('refuses a node kind it does not know, by name', async () => {
    const walk = await import('./ir/walk.ts');
    const alien = { kind: 'somethingNew', span: { start: 0, end: 0 } } as never;
    expect(() => walk.childExprs(alien)).toThrow(/somethingNew/);
    expect(() => walk.exprsOf(alien)).toThrow(/somethingNew/);
    expect(() => walk.bodiesOf(alien)).toThrow(/somethingNew/);
  });

  it('names every `IrExpr` and `IrStmt` kind the IR declares', () => {
    /*
     * Read from the IR's own source rather than from a list kept here, because a list kept here is
     * the second description that goes stale — which is the failure this whole file is about.
     *
     * Through `import.meta.glob` rather than `node:fs`, for the reason `examples.test.ts` gives:
     * `tsconfig.json` sets `"types": []` so a package cannot name Node's globals, and a test in the
     * same directory is held to it.
     */
    const source = sources['./ir/ir.ts'];
    const walk = sources['./ir/walk.ts'];
    expect(source).toBeDefined();
    expect(walk).toBeDefined();

    /* The two unions a walker traverses, and not `IrType` beside them — a type has no children to
       miss, and folding it in here would make this assert something it is not about. */
    const union = (name: string): readonly string[] => {
      const start = source.indexOf(`export type ${name} =`);
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf('\nexport ', start + 1);
      const body = source.slice(start, end === -1 ? undefined : end);
      return [...body.matchAll(/readonly kind: '([a-zA-Z]+)'/g)].map((m) => m[1] as string);
    };

    const declared = new Set([...union('IrExpr'), ...union('IrStmt')]);
    expect(declared.size).toBeGreaterThan(20);
    const missing = [...declared].filter((kind) => !walk.includes(`case '${kind}'`));
    expect(missing).toEqual([]);
  });
});

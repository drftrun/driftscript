import { describe, expect, it } from 'vitest';
import { parse } from '../parser.ts';
import { check } from '../check/checker.ts';
import { lower } from '../ir/lower.ts';
import { emitJs } from './js.ts';
import { compileDriftScript, singleFileHost } from '../index.ts';

const PULSE = `data PulseState {
    phase: f32 = 0
}

fn update(state: mut PulseState, dt: f32) {
    state.phase += dt
}
`;

const emit = (source: string, filename = 'pulse.drs') => {
  const { module } = parse(source, filename);
  return emitJs(lower(module, check(module, filename)), { filename, source });
};

/**
 * Import generated code the way a browser would, without Node's `Buffer`.
 *
 * `tsconfig.json` sets `"types": []` so that `process`, `Buffer` and `require` cannot compile
 * inside a package — the same rule that keeps them out of a consumer's bundle keeps them out of
 * this test. `btoa` is in the DOM lib the config already includes, and generated code is ASCII.
 */
const importGenerated = (code: string) =>
  import(/* @vite-ignore */ `data:text/javascript;base64,${btoa(code)}`);

describe('the JavaScript backend', () => {
  it('emits a factory per data declaration and a named export per function', () => {
    const { code } = emit(PULSE);
    expect(code).toContain('export function createPulseState()');
    expect(code).toContain('export function update(state, dt)');
  });

  it('emits code a browser can run, with no Node assumptions', () => {
    const { code } = emit(PULSE);
    for (const forbidden of ['require(', 'process.', '__dirname', 'Buffer', 'node:']) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('emits generated code that actually runs and mutates state', async () => {
    const mod = await importGenerated(emit(PULSE).code);
    const state = mod.createPulseState();
    expect(state.phase).toBe(0);
    mod.update(state, 0.5);
    mod.update(state, 0.25);
    expect(state.phase).toBeCloseTo(0.75, 10);
  });

  it('emits a record with no fields without producing invalid syntax', async () => {
    const mod = await importGenerated(emit('data Empty {\n}\n').code);
    expect(mod.createEmpty()).toEqual({});
  });

  it('emits a v3 source map carrying the original source', () => {
    const { map } = emit(PULSE);
    expect(map.version).toBe(3);
    expect(map.sources).toEqual(['pulse.drs']);
    expect(map.sourcesContent).toEqual([PULSE]);
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  it('maps the generated update body back to the .drs line it came from', async () => {
    const { code, map } = emit(PULSE);
    const { SourceMapConsumer } = await import('source-map-js');
    const consumer = new SourceMapConsumer(map as never);

    const lines = code.split('\n');
    const generatedLine = lines.findIndex((l) => l.includes('state.phase =')) + 1;
    expect(generatedLine).toBeGreaterThan(0);
    const generatedColumn = lines[generatedLine - 1].indexOf('state.phase');

    const original = consumer.originalPositionFor({ line: generatedLine, column: generatedColumn });
    expect(original.source).toBe('pulse.drs');
    /* `    state.phase += dt` is line 6 of PULSE, one-based. */
    expect(original.line).toBe(6);
  });

  it('maps each declaration back to its own line rather than all to the first', async () => {
    const { code, map } = emit(PULSE);
    const { SourceMapConsumer } = await import('source-map-js');
    const consumer = new SourceMapConsumer(map as never);

    const lines = code.split('\n');
    const dataLine = lines.findIndex((l) => l.includes('createPulseState')) + 1;
    const fnLine = lines.findIndex((l) => l.includes('export function update')) + 1;

    const dataOriginal = consumer.originalPositionFor({ line: dataLine, column: 0 });
    const fnOriginal = consumer.originalPositionFor({ line: fnLine, column: 0 });

    expect(dataOriginal.line).toBe(1);
    expect(fnOriginal.line).toBe(5);
    expect(fnOriginal.line).not.toBe(dataOriginal.line);
  });

  /*
   * Every decoded segment is well-formed, which the position lookups above cannot see.
   *
   * `originalPositionFor` returns the nearest mapping at or before the column asked for, so a map
   * whose column deltas are wrong still answers plausibly when a generated line carries one
   * mapping. Removing the per-line column reset in `MappingBuilder` — a real bug, since the
   * decoder resets its own accumulator and would compute a negative column — left every test above
   * green. This is the one that fails.
   */
  it('decodes to segments with non-negative, in-order columns on every line', async () => {
    const { map } = emit(PULSE);
    const { SourceMapConsumer } = await import('source-map-js');
    const consumer = new SourceMapConsumer(map as never);

    const byLine = new Map<number, number[]>();
    consumer.eachMapping((mapping) => {
      expect(mapping.generatedColumn).toBeGreaterThanOrEqual(0);
      expect(mapping.originalColumn).toBeGreaterThanOrEqual(0);
      expect(mapping.originalLine).toBeGreaterThanOrEqual(1);
      const columns = byLine.get(mapping.generatedLine) ?? [];
      columns.push(mapping.generatedColumn);
      byLine.set(mapping.generatedLine, columns);
    });

    expect(byLine.size).toBeGreaterThan(0);
    for (const columns of byLine.values()) {
      expect(columns).toEqual([...columns].sort((a, b) => a - b));
    }
  });

  it('maps each record field back to its own source line', async () => {
    const source = 'data P {\n    a: f32 = 1\n    b: f32 = 2\n    c: f32 = 3\n}\n';
    const { code, map } = emit(source, 'multi.drs');
    const { SourceMapConsumer } = await import('source-map-js');
    const consumer = new SourceMapConsumer(map as never);

    const lines = code.split('\n');
    const originals = ['a:', 'b:', 'c:'].map((needle) => {
      const generatedLine = lines.findIndex((l) => l.trim().startsWith(needle)) + 1;
      expect(generatedLine).toBeGreaterThan(0);
      const column = lines[generatedLine - 1].indexOf(needle);
      return consumer.originalPositionFor({ line: generatedLine, column }).line;
    });

    /* Fields are emitted one per line so each carries its own mapping. A single-line object
       literal maps every field to the same generated position, which turns a stack trace inside
       an initialiser into a pointer at the record rather than at the field. */
    expect(originals).toEqual([2, 3, 4]);
  });

  it('records the module requirements on the metadata export', () => {
    const { code } = emit('import { play } from "drift/audio"\n\ndata P {\n    a: f32 = 0\n}\n');
    expect(code).toContain('__drift');
    expect(code).toContain('drift/audio');
  });

  it('records each record shape, which is what a hot patch compares', async () => {
    const mod = await importGenerated(emit(PULSE).code);
    expect(mod.__drift.shapes).toEqual({ PulseState: ['phase'] });
  });

  it('escapes a name that is reserved in JavaScript but legal in DriftScript', async () => {
    const mod = await importGenerated(
      emit('data P {\n    a: f32 = 0\n}\n\nfn f(in: mut P, dt: f32) {\n    in.a += dt\n}\n').code,
    );
    const state = mod.createP();
    mod.f(state, 2);
    expect(state.a).toBe(2);
  });

  it('emits erased units as bare numbers the runtime never sees a tag for', async () => {
    const mod = await importGenerated(emit('data P {\n    delay: f32 = 250ms\n}\n').code);
    const value = mod.createP();
    expect(value.delay).toBeCloseTo(0.25, 12);
    expect(typeof value.delay).toBe('number');
  });
});

describe('emitted imports', () => {
  const DOG =
    'data Dog {\n    energy: f32 = 1\n}\n\nenum Mood {\n    Calm\n    Alert\n}\n\n' +
    'fn rest(d: mut Dog) {\n    d.energy = 1\n}\n';

  const files: Record<string, string> = {
    '/a/dog.drs': DOG,
    /* A path a filesystem allows and a hand-quoted emitter could not survive. */
    "/a/it's.drs": DOG,
  };

  const host = {
    resolve(specifier: string, from: string) {
      const parts = from.slice(0, from.lastIndexOf('/')).split('/');
      for (const segment of specifier.split('/')) {
        if (segment === '.') continue;
        else if (segment === '..') parts.pop();
        else parts.push(segment);
      }
      const id = `${parts.join('/')}.drs`;
      return files[id] === undefined ? null : id;
    },
    load: (id: string) => files[id] ?? null,
  };

  const emit = (source: string) =>
    compileDriftScript(source, { filename: '/a/wolf.drs', host, mode: 'development' }).code;

  /*
   * The expected import line, assembled rather than written out.
   *
   * `scripts/boundaries.test.mjs` scans every source file for `from '<relative>'` and checks it
   * resolves, and it strips comments but not string literals — so a literal here reads as this test
   * file importing a `.drs` that does not exist. Keeping the two tokens apart in the source is the
   * cheap side of that fix; the alternative is teaching a guard to parse JavaScript strings, which
   * is a lot of machinery to make one assertion prettier.
   */
  const importOf = (names: string, from: string) =>
    `import { ${names} } from${' '}${JSON.stringify(from)};`;

  it('imports a function it calls, with the extension a bundler needs', () => {
    const code = emit(
      'import { Dog, rest } from "./dog"\n\nfn go(d: mut Dog) {\n    rest(d)\n}\n',
    );
    expect(code).toContain(importOf('rest', './dog.drs'));
  });

  it('imports an enum it reads', () => {
    const code = emit('import { Mood } from "./dog"\n\nfn pick() -> Mood {\n    return Mood.Calm\n}\n');
    expect(code).toContain(importOf('Mood', './dog.drs'));
  });

  it('serialises the specifier rather than quoting it', () => {
    /*
     * **A module specifier is source-derived text entering JavaScript syntax.** The parser takes
     * whatever sits between the quotes and a filesystem host resolves it as a path, so a directory
     * with an apostrophe in its name — which every filesystem allows — produced generated output
     * that would not parse. The emitter had typed the quotes itself.
     *
     * Asserted by *parsing* the result rather than by matching a string: the failure is that the
     * output is not JavaScript, and only a parser can say that.
     */
    const awkward = "./it's";
    const code = emit(
      `import { Dog, rest } from "${awkward}"\n\nfn go(d: mut Dog) {\n    rest(d)\n}\n`,
    );

    expect(code).toContain(importOf('rest', "./it's.drs"));

    /*
     * The literal is read back **by JavaScript**, not by a string match: the failure being guarded
     * against is that the emitted text is not a JavaScript string at all, and only a parser can say
     * so. `new Function` throws on a malformed literal, and its value is the path the host was
     * asked for rather than one an escape sequence rewrote.
     */
    const line = code.split('\n').find((l) => l.startsWith('import ')) ?? '';
    const literal = line.slice(line.indexOf('from ') + 'from '.length, -1);
    expect(new Function(`return ${literal}`)()).toBe("./it's.drs");
  });

  it('emits no import for a name used only as a type', () => {
    /*
     * Types are erased, so there is nothing to import — and importing anyway would be worse than
     * useless: a record exports `createDog`, not `Dog`, so the import would name an export that does
     * not exist and the module would fail to load.
     */
    const code = emit('import { Dog } from "./dog"\n\nfn go(d: mut Dog) {\n    d.energy = 0\n}\n');
    expect(code).not.toContain('import');
  });

  it('names only the values in an import that mixes a type with a function', () => {
    const code = emit(
      'import { Dog, rest } from "./dog"\n\nfn go(d: mut Dog) {\n    rest(d)\n}\n',
    );
    expect(code).toContain(importOf('rest', './dog.drs'));
    expect(code).not.toContain('Dog }');
  });

  it('puts the import above everything, because a binding is read before it is written', () => {
    const code = emit('import { Mood } from "./dog"\n\nfn pick() -> Mood {\n    return Mood.Calm\n}\n');
    expect(code.trimStart().startsWith('import ')).toBe(true);
  });
});

describe('a subtype constructor', () => {
  const emitLocal = (source: string) =>
    compileDriftScript(source, {
      filename: '/a/w.drs',
      host: singleFileHost(),
      mode: 'development',
    }).code;

  const PAIR =
    'data Dog {\n    name: String = "rex"\n    energy: f32 = 7\n}\n\n' +
    'data Wolf : Dog {\n    packSize: i32 = 4\n}\n';

  it('inlines the base defaults into one object literal', () => {
    const code = emitLocal(PAIR);
    expect(code).toContain(
      'export function createWolf() {\n  return {\n    name: "rex",\n    energy: 7,\n    packSize: 4,\n  };\n}',
    );
  });

  it('allocates once, with no spread and no call into the base constructor', () => {
    /*
     * Both alternatives allocate twice, and a record constructor may be a per-frame path; the
     * spread is forbidden outright by AGENTS.md. Asserted against the constructor's *body* rather
     * than the whole module, because the module of course contains `export function createDog() {`
     * — the first version of this test read that as a call and failed on correct output.
     */
    const body = /export function createWolf\(\) \{([\s\S]*?)\n\}/.exec(emitLocal(PAIR))?.[1];
    expect(body).toBeDefined();
    expect(body).not.toContain('...');
    expect(body).not.toContain('createDog');
  });

  it('carries the concrete layout in __drift.shapes, base fields included', () => {
    /* This is what patchModule compares on a hot reload. A shape listing only a record's own fields
       would call two different layouts the same and patch across them. */
    expect(emitLocal(PAIR)).toContain('"Wolf":["name","energy","packSize"]');
  });

  it('keeps the base its own shape as well', () => {
    expect(emitLocal(PAIR)).toContain('"Dog":["name","energy"]');
  });

  it('flattens a chain of three in one literal', () => {
    const code = emitLocal(
      'data A {\n    a: f32 = 1\n}\n\ndata B : A {\n    b: f32 = 2\n}\n\ndata C : B {\n    c: f32 = 3\n}\n',
    );
    expect(code).toContain(
      'export function createC() {\n  return {\n    a: 1,\n    b: 2,\n    c: 3,\n  };\n}',
    );
  });

  it('takes the defaults of a base declared after it', () => {
    /* Base resolution does not care about declaration order, so lowering must not either. */
    const code = emitLocal(
      'data Wolf : Dog {\n    packSize: i32 = 4\n}\n\ndata Dog {\n    energy: f32 = 7\n}\n',
    );
    expect(code).toContain('export function createWolf() {\n  return {\n    energy: 7,\n    packSize: 4,\n  };\n}');
  });
});

describe('a subtype of an imported base', () => {
  const files: Record<string, string> = {
    '/a/dog.drs': 'data Dog {\n    name: String = "rex"\n    energy: f32 = 7\n}\n',
  };
  const crossHost = {
    resolve(specifier: string, from: string) {
      const parts = from.slice(0, from.lastIndexOf('/')).split('/');
      for (const segment of specifier.split('/')) {
        if (segment === '.') continue;
        else if (segment === '..') parts.pop();
        else parts.push(segment);
      }
      const id = `${parts.join('/')}.drs`;
      return files[id] === undefined ? null : id;
    },
    load: (id: string) => files[id] ?? null,
  };

  const WOLF = 'import { Dog } from "./dog"\n\ndata Wolf : Dog {\n    packSize: i32 = 4\n}\n';

  const code = () =>
    compileDriftScript(WOLF, { filename: '/a/wolf.drs', host: crossHost, mode: 'development' }).code;

  it('inlines the defaults declared in the other file', () => {
    /*
     * The values come from `dog.drs`, so they can only be here if the other module's record was
     * lowered. Falling back to a zero for each inherited field would compile, run, and give every
     * wolf an empty name and no energy — a wrong value rather than an error.
     */
    expect(code()).toContain(
      'export function createWolf() {\n  return {\n    name: "rex",\n    energy: 7,\n    packSize: 4,\n  };\n}',
    );
  });

  it('carries the inherited fields in its shape', () => {
    expect(code()).toContain('"Wolf":["name","energy","packSize"]');
  });

  it('emits no import for the base, because a record has no runtime name', () => {
    expect(code()).not.toContain('import');
  });
});

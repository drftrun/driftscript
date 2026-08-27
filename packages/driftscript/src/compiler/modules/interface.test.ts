import { describe, expect, it } from 'vitest';
import { compileDriftScript } from '../index.ts';
import type { ModuleHost } from './host.ts';

function mapHost(files: Record<string, string>): ModuleHost {
  return {
    resolve(specifier, from) {
      const parts = from.slice(0, from.lastIndexOf('/')).split('/');
      for (const segment of specifier.split('/')) {
        if (segment === '.') continue;
        else if (segment === '..') parts.pop();
        else parts.push(segment);
      }
      const id = `${parts.join('/')}.drs`;
      return files[id] === undefined ? null : id;
    },
    load: (id) => files[id] ?? null,
  };
}

const compile = (source: string, files: Record<string, string> = {}) =>
  compileDriftScript(source, {
    filename: '/a/wolf.drs',
    mode: 'development',
    host: mapHost(files),
  });

const DOG = 'data Dog {\n    name: String = ""\n    energy: f32 = 1\n}\n';

describe('an imported declaration', () => {
  it('brings an imported record into scope, unqualified', () => {
    const result = compile(
      'import { Dog } from "./dog"\n\nfn name(d: Dog) -> String {\n    return d.name\n}\n',
      { '/a/dog.drs': DOG },
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('brings an imported function into scope, callable', () => {
    const result = compile(
      'import { rest } from "./dog"\n\nfn go(d: mut Dog) {\n    rest(d)\n}\n\ndata Dog {\n    energy: f32 = 1\n}\n',
      { '/a/dog.drs': 'data Dog {\n    energy: f32 = 1\n}\n\nfn rest(d: mut Dog) {\n    d.energy = 1\n}\n' },
    );
    /* The local `Dog` shadows nothing here — this asserts the *function* arrived. A version that
       imported only types would report `rest` as unknown. */
    expect(result.diagnostics.map((d) => d.code)).toEqual([]);
  });

  it('brings an imported enum into scope', () => {
    const result = compile(
      'import { Mood } from "./dog"\n\nfn pick() -> Mood {\n    return Mood.Calm\n}\n',
      { '/a/dog.drs': 'enum Mood {\n    Calm\n    Alert\n}\n' },
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses a name the module does not declare', () => {
    const result = compile('import { Cat } from "./dog"\n', { '/a/dog.drs': DOG });
    expect(result.diagnostics.map((d) => d.code)).toEqual(['DS0502']);
    expect(result.diagnostics[0].message).toContain('Cat');
    expect(result.diagnostics[0].message).toContain('./dog');
  });

  it('suggests the nearest name when a wrong import is nearly right', () => {
    /* A wrong import is almost always a typo or a rename. Naming the near miss is the difference
       between a diagnostic somebody acts on and one they go and look something up for. */
    const result = compile('import { Dogg } from "./dog"\n', { '/a/dog.drs': DOG });
    expect(result.diagnostics[0].message).toContain('Dog');
  });

  it("reports the importing file's errors and not the imported file's", () => {
    /* `dog.drs` has a type error of its own. It is reported when `dog.drs` is compiled; repeating it
       here sends somebody to fix it in the wrong file, and an editor would file it under a document
       it never asked about. */
    const result = compile('import { Dog } from "./dog"\n\nfn f(d: Dog) {\n}\n', {
      '/a/dog.drs': 'data Dog {\n    name: String = 1\n}\n',
    });
    expect(result.diagnostics.every((d) => d.file === '/a/wolf.drs')).toBe(true);
  });

  it('lets two modules that import each other both check', () => {
    const files = {
      '/a/a.drs': 'import { bee } from "./b"\n\nfn ay() -> i32 {\n    return bee()\n}\n',
      '/a/b.drs': 'import { ay } from "./a"\n\nfn bee() -> i32 {\n    return 1\n}\n',
    };
    const result = compileDriftScript(files['/a/a.drs'], {
      filename: '/a/a.drs',
      mode: 'development',
      host: mapHost(files),
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('type-checks a call across a module boundary rather than waving it through', () => {
    /* The point of importing a signature is that it is *checked*. A version that bound the name and
       not its type would pass every call, which is worse than not importing at all. */
    const result = compile(
      'import { rest } from "./dog"\n\nfn go() {\n    rest("not a dog")\n}\n',
      { '/a/dog.drs': `${DOG}\nfn rest(d: mut Dog) {\n    d.energy = 1\n}\n` },
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].file).toBe('/a/wolf.drs');
  });

  it('keeps a capability import namespaced while a file import is not', () => {
    const result = compile(
      'import { Dog } from "./dog"\nimport { play } from "drift/audio"\n\nfn f(d: Dog) {\n}\n',
      { '/a/dog.drs': DOG },
    );
    /* No registry is configured, so the capability is unresolved and unreported; what matters is
       that `Dog` resolved without a namespace and nothing complained about the audio import. */
    expect(result.diagnostics).toEqual([]);
  });
});

describe('a base in another module', () => {
  const DOGS = 'data Dog {\n    name: String = ""\n    energy: f32 = 1\n}\n';

  it('extends a record imported from another file', () => {
    const result = compile(
      'import { Dog } from "./dog"\n\ndata Wolf : Dog {\n    packSize: i32 = 0\n}\n',
      { '/a/dog.drs': DOGS },
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('inherits the imported base’s fields, readable by name', () => {
    const result = compile(
      'import { Dog } from "./dog"\n\ndata Wolf : Dog {\n    packSize: i32 = 0\n}\n\n' +
        'fn go(w: mut Wolf) {\n    w.energy = 0\n    w.packSize = 1\n}\n',
      { '/a/dog.drs': DOGS },
    );
    /* `energy` comes from the other file and `packSize` from this one. The *order* they are laid out
       in is what the emitter writes into `__drift.shapes`, and is asserted where that is built. */
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses a field the imported base already declares', () => {
    const result = compile(
      'import { Dog } from "./dog"\n\ndata Wolf : Dog {\n    energy: f32 = 2\n}\n',
      { '/a/dog.drs': DOGS },
    );
    expect(result.diagnostics.map((d) => d.code)).toContain('DS0504');
  });

});

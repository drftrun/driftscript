import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost} from 'driftscript/compiler';
import { createRegistry, defineCapability, defineTarget } from 'driftscript';
import { createService } from './service.ts';

/**
 * The server finds exactly what the build finds.
 *
 * **This is the most important test in this package**, and everything else here is refinement on
 * top of it. A server that disagrees with the build teaches people to distrust its squiggles, and
 * they are right to distrust them: a squiggle that is sometimes wrong costs attention every time it
 * appears. There must be no class of error only the editor finds, and none it misses.
 *
 * Asserted by deep equality over the whole diagnostic array rather than by comparing counts. A
 * count agrees while the codes, the spans and the words differ, which is most of what would
 * actually go wrong — a server that filters warnings, or reports a span one token wide where the
 * build reports the whole expression.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

const sources = {
  ...import.meta.glob('../../driftscript/examples/*.drs', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob('../../../docs/corpus/*.drs', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
};

const files = Object.entries(sources)
  .map(([path, source]) => [path.split('/').pop() as string, source] as const)
  .sort((a, b) => a[0].localeCompare(b[0]));

/** A host describing the wired surfaces, so the comparison covers capability diagnostics too. */
const registry = () => {
  const r = createRegistry();
  r.addType({ module: 'drift/scene', name: 'Node', doc: 'A node in the scene graph.' });
  const define = (
    module: string,
    name: string,
    params: { name: string; type: string }[],
    returns: string,
    effects: Parameters<typeof defineCapability>[0]['effects'],
    deterministic: boolean,
  ) =>
    r.add(
      defineCapability({
        module,
        name,
        signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
        params,
        returns,
        effects,
        deterministic,
        doc: `${module}.${name}`,
        implementation: `${module}.${name}`,
      }),
    );
  define('drift/audio', 'play', [{ name: 'slot', type: 'String' }], 'void', ['audio.write'], false);
  define(
    'drift/audio',
    'bus',
    [
      { name: 'name', type: 'String' },
      { name: 'gain', type: 'f32' },
    ],
    'void',
    ['audio.write'],
    false,
  );
  define('drift/time', 'frameDelta', [], 'f32', ['clock.read'], false);
  define('drift/scene', 'position', [{ name: 'node', type: 'Node' }], 'f32', ['scene.read'], true);
  define(
    'drift/scene',
    'distanceBetween',
    [
      { name: 'a', type: 'Node' },
      { name: 'b', type: 'Node' },
    ],
    'f32',
    ['scene.read'],
    true,
  );
  return r;
};

const manifest = defineTarget('full', ['drift/audio', 'drift/time', 'drift/scene']);

describe('the server agrees with the build', () => {
  it('finds the files, so an empty glob is a failure rather than a pass', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each(files)('%s produces the same diagnostics as a build would', (name, source) => {
    const service = createService({ registry: registry(), manifest });
    service.open(name, source);

    const fromBuild = compileDriftScript(source, {
      filename: name,
      registry: registry(),
      manifest,
      host: singleFileHost(),
      mode: 'development',
    }).diagnostics;

    expect(service.rawDiagnostics(name)).toEqual(fromBuild);
  });

  it('agrees on a file with errors, not only on clean ones', () => {
    const broken =
      'data P {\n    a: f32 = "x"\n    b: f32 = "y"\n}\n\nfn f(p: P) {\n    p.missing = 1\n}\n';
    const service = createService();
    service.open('broken.drs', broken);

    const fromBuild = compileDriftScript(broken, {
      filename: 'broken.drs',
      host: singleFileHost(),
      mode: 'development',
    }).diagnostics;

    expect(service.rawDiagnostics('broken.drs')).toEqual(fromBuild);
    expect(fromBuild.length).toBeGreaterThan(0);
  });

  it('publishes no warnings the build would not, and drops none it would', () => {
    /*
     * Filtering by severity is the obvious thing a server does and the exact way it stops agreeing.
     *
     * The fixture has to *contain* a warning or the assertion is vacuous — which it was on the first
     * write, because nothing in the corpus produced one and a `severity === 'error'` filter passed
     * the whole suite. An unused import is the warning, and it is asserted present before the
     * comparison so this cannot go quiet again if the rule changes.
     */
    const source =
      'import { play, bus } from "drift/audio"\n\nfn ring() {\n    audio.play("kick")\n}\n';
    const service = createService({ registry: registry(), manifest });
    service.open('a.drs', source);

    const fromBuild = compileDriftScript(source, {
      filename: 'a.drs',
      registry: registry(),
      manifest,
      host: singleFileHost(),
      mode: 'development',
    });

    expect(fromBuild.diagnostics.some((d) => d.severity === 'warning')).toBe(true);
    expect(service.rawDiagnostics('a.drs')).toEqual(fromBuild.diagnostics);
  });

  it('reports the same span, converted to editor coordinates without moving', () => {
    const source = 'data P {\n    a: f32 = "x"\n}\n';
    const service = createService();
    service.open('a.drs', source);

    const [raw] = service.rawDiagnostics('a.drs');
    const [published] = service.diagnostics('a.drs');
    const document = service.document('a.drs');

    expect(document?.offsetAt(published.range.start)).toBe(raw.start);
    expect(document?.offsetAt(published.range.end)).toBe(raw.end);
    /* `"x"` is on line 2 (one-based), which is line 1 zero-based. */
    expect(published.range.start.line).toBe(1);
  });
});

describe('the document store', () => {
  it('round-trips every offset in a document through position and back', () => {
    const text = 'data P {\n    a: f32 = 0\n}\n\nfn f() {\n}\n';
    const service = createService();
    service.open('a.drs', text);
    const document = service.document('a.drs');

    for (let offset = 0; offset <= text.length; offset += 1) {
      expect(document?.offsetAt(document.positionAt(offset))).toBe(offset);
    }
  });

  it('clamps a position past the end rather than answering one that does not exist', () => {
    const text = 'fn f() {\n}\n';
    const service = createService();
    service.open('a.drs', text);
    const document = service.document('a.drs');
    /* Against `text.length` rather than a counted number: a hardcoded offset is a second place the
       fixture's length is written down, and the two drift the moment somebody edits the fixture. */
    expect(document?.offsetAt({ line: 99, character: 0 })).toBe(text.length);
    expect(document?.offsetAt({ line: -1, character: 0 })).toBe(0);
    expect(document?.positionAt(9999)).toEqual(document?.positionAt(text.length));
  });

  it('clamps a character past the end of its line to that line, not into the next', () => {
    const service = createService();
    service.open('a.drs', 'ab\ncd\n');
    const document = service.document('a.drs');
    /* Running off the end of line 0 must not land inside line 1. An editor sends this whenever a
       selection extends past a short line. */
    expect(document?.offsetAt({ line: 0, character: 99 })).toBe(3);
  });

  it('bumps the version on a change, which is what invalidates the compile cache', () => {
    const service = createService();
    service.open('a.drs', 'fn f() {\n}\n');
    expect(service.document('a.drs')?.version).toBe(1);
    service.change('a.drs', 'fn g() {\n}\n');
    expect(service.document('a.drs')?.version).toBe(2);
  });

  it('recompiles after a change rather than serving the previous result', () => {
    const service = createService();
    service.open('a.drs', 'data P {\n    a: f32 = 0\n}\n');
    expect(service.rawDiagnostics('a.drs')).toEqual([]);

    service.change('a.drs', 'data P {\n    a: f32 = "x"\n}\n');
    expect(service.rawDiagnostics('a.drs').length).toBeGreaterThan(0);
  });

  it('reuses the compile for a second query at the same version', () => {
    const service = createService();
    service.open('a.drs', 'data P {\n    a: f32 = 0\n}\n');
    expect(service.compile('a.drs')).toBe(service.compile('a.drs'));
  });

  it('answers nothing for a document nobody opened', () => {
    const service = createService();
    expect(service.diagnostics('missing.drs')).toEqual([]);
    expect(service.compile('missing.drs')).toBeUndefined();
  });

  it('forgets a closed document', () => {
    const service = createService();
    service.open('a.drs', 'fn f() {\n}\n');
    service.close('a.drs');
    expect(service.document('a.drs')).toBeUndefined();
  });
});

describe('formatting through the service', () => {
  it('returns exactly what the formatter returns', () => {
    const service = createService();
    service.open('a.drs', 'data P{a:f32=0}\n');
    expect(service.formatting('a.drs')).toBe('data P { a: f32 = 0 }\n');
  });

  it('leaves a file with a syntax error alone, so format-on-save cannot mangle it', () => {
    const half = 'data P {\n    a: f32\n';
    const service = createService();
    service.open('a.drs', half);
    expect(service.formatting('a.drs')).toBe(half);
  });
});

/**
 * The agreement, across files.
 *
 * **It matters more here than it did within one file**, because the server and the build now resolve
 * modules through *different hosts* — one reads open documents, the other reads a map or a disk. A
 * disagreement is no longer about how a file is read; it is about what code exists.
 */
describe('the server and the build agree across a module boundary', () => {
  /*
   * The real corpus, not a fixture written beside the assertion.
   *
   * `docs/corpus/animals/` is two files written to be read: one declares a record and reaches a
   * capability, the other extends it across the file boundary and inherits the requirement. Reading
   * them here is what makes them a corpus rather than two files nobody opens — and it means this
   * test breaks when the language changes under them, which is the point of having them.
   */
  const corpus: Record<string, string> = import.meta.glob(
    '../../../docs/corpus/animals/*.drs',
    { query: '?raw', import: 'default', eager: true },
  );

  const files: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(corpus).map(([path, source]) => [`/a/${path.split('/').pop()}`, source]),
    ),
    /* One file the corpus deliberately does not contain: a wrong import. The corpus is written to be
       correct, so the disagreement most worth catching needs a case that is not. */
    '/a/broken.drs': 'import { Nope } from "./traits"\n\nfn f() {\n}\n',
  };

  const buildHost = {
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

  const opened = () => {
    const service = createService({ readFile: (id) => files[id] ?? null });
    for (const [uri, text] of Object.entries(files)) service.open(uri, text);
    return service;
  };

  it('reports the same diagnostics for every file, byte for byte', () => {
    const service = opened();
    for (const [uri, source] of Object.entries(files)) {
      const fromBuild = compileDriftScript(source, {
        filename: uri,
        host: buildHost,
        mode: 'development',
      });
      expect(service.rawDiagnostics(uri)).toEqual(fromBuild.diagnostics);
    }
  });

  /*
   * **No registry, and that limits what this proves.** Both sides compile without one, so capability
   * calls resolve to nothing and their arity is never checked — which is agreement about agreement,
   * not about capabilities. This package may not import an engine package, so the real signatures
   * are out of reach here; a host's own suite compiles the same files against
   * them. Written down because the first version of this test asserted "the good files are good"
   * while one of them called `audio.play` with one argument of two.
   */
  it('reads the corpus rather than passing on an empty set', () => {
    /* A glob that matches nothing makes every assertion here vacuously true. */
    expect(Object.keys(corpus).length).toBe(2);
  });

  it('agrees that the good files are good and the bad one is bad', () => {
    /* Without this the test above passes when both sides report nothing at all, which is what a
       server that failed to resolve anything would do. */
    const service = opened();
    expect(service.rawDiagnostics('/a/traits.drs')).toEqual([]);
    expect(service.rawDiagnostics('/a/wolf.drs')).toEqual([]);
    expect(service.rawDiagnostics('/a/broken.drs').map((d) => d.code)).toEqual(['DS0502']);
  });

  it('agrees on the interface hash, which is what the scheduler compares', () => {
    /* Diagnostics are not the only thing the two produce. A server whose hashes differed from the
       build's would schedule against numbers no build ever computed. */
    const service = opened();
    for (const [uri, source] of Object.entries(files)) {
      const fromBuild = compileDriftScript(source, {
        filename: uri,
        host: buildHost,
        mode: 'development',
      });
      expect(service.compile(uri)?.metadata.interfaceHash).toBe(fromBuild.metadata.interfaceHash);
    }
  });
});

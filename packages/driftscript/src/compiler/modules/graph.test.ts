import { describe, expect, it } from 'vitest';
import { resolveGraph } from './graph.ts';
import type { ModuleHost } from './host.ts';

/**
 * A host over a literal map of files.
 *
 * Resolution is the one thing a real host does that this must imitate exactly: `./dog` from
 * `/a/wolf.drs` is `/a/dog.drs`, and `../lib/dog` from `/a/b/wolf.drs` is `/a/lib/dog.drs`. Doing
 * it with string arithmetic here rather than with a path library keeps the fixture readable and
 * keeps this test about the graph rather than about resolution.
 */
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

const DOG = 'data Dog {\n    name: String = ""\n}\n';

describe('resolveGraph', () => {
  it('reaches a module through a relative import', () => {
    const graph = resolveGraph(
      '/a/wolf.drs',
      'import { Dog } from "./dog"\n',
      mapHost({ '/a/dog.drs': DOG }),
    );
    expect([...graph.modules.keys()].sort()).toEqual(['/a/dog.drs', '/a/wolf.drs']);
    expect(graph.diagnostics).toEqual([]);
  });

  it('reaches a module through a parent-relative import', () => {
    const graph = resolveGraph(
      '/a/b/wolf.drs',
      'import { Dog } from "../dog"\n',
      mapHost({ '/a/dog.drs': DOG }),
    );
    expect(graph.modules.has('/a/dog.drs')).toBe(true);
  });

  it('follows a chain rather than only the first step', () => {
    const files = {
      '/a/dog.drs': DOG,
      '/a/mid.drs': 'import { Dog } from "./dog"\n',
    };
    const graph = resolveGraph('/a/wolf.drs', 'import { Dog } from "./mid"\n', mapHost(files));
    expect(graph.modules.size).toBe(3);
  });

  it('ignores a capability import, which no host resolves', () => {
    const graph = resolveGraph(
      '/a/wolf.drs',
      'import { play } from "drift/audio"\n',
      mapHost({}),
    );
    expect(graph.diagnostics).toEqual([]);
    expect(graph.modules.size).toBe(1);
  });

  it('puts two modules that import each other in one component', () => {
    const files = {
      '/a/a.drs': 'import { bee } from "./b"\n\nfn ay() {\n}\n',
      '/a/b.drs': 'import { ay } from "./a"\n\nfn bee() {\n}\n',
    };
    const graph = resolveGraph('/a/a.drs', files['/a/a.drs'], mapHost(files));
    expect([...graph.component].sort()).toEqual(['/a/a.drs', '/a/b.drs']);
  });

  it('puts a module with no cycle in a component of one', () => {
    const graph = resolveGraph(
      '/a/wolf.drs',
      'import { Dog } from "./dog"\n',
      mapHost({ '/a/dog.drs': DOG }),
    );
    expect(graph.component).toEqual(['/a/wolf.drs']);
  });

  it('finds a cycle of three', () => {
    const files = {
      '/a/a.drs': 'import { b } from "./b"\n',
      '/a/b.drs': 'import { c } from "./c"\n',
      '/a/c.drs': 'import { a } from "./a"\n',
    };
    const graph = resolveGraph('/a/a.drs', files['/a/a.drs'], mapHost(files));
    expect([...graph.component].sort()).toEqual(['/a/a.drs', '/a/b.drs', '/a/c.drs']);
  });

  it('refuses a specifier that does not resolve, naming it', () => {
    const graph = resolveGraph('/a/wolf.drs', 'import { Dog } from "./dog"\n', mapHost({}));
    expect(graph.diagnostics).toHaveLength(1);
    expect(graph.diagnostics[0].code).toBe('DS0501');
    expect(graph.diagnostics[0].message).toContain('./dog');
  });

  it('puts the refusal on the import rather than at the top of the file', () => {
    const source = 'data P {\n    a: f32 = 0\n}\n\nimport { Dog } from "./dog"\n';
    const graph = resolveGraph('/a/wolf.drs', source, mapHost({}));
    /* The caret has to land where the reader can act. A refusal at offset zero points at a
       declaration that is fine. */
    expect(graph.diagnostics[0].start).toBe(source.indexOf('import'));
  });

  it('says a module did not parse rather than cascading about its names', () => {
    const graph = resolveGraph(
      '/a/wolf.drs',
      'import { Dog } from "./dog"\n',
      mapHost({ '/a/dog.drs': 'data Dog {\n' }),
    );
    expect(graph.diagnostics.map((d) => d.code)).toEqual(['DS0506']);
    expect(graph.diagnostics[0].message).toContain('./dog');
  });

  it('reports the unparseable import against the file that wrote it', () => {
    /* Not against `dog.drs`: that file reports its own errors when it is compiled, and a diagnostic
       filed under a document the editor did not ask about is a diagnostic nobody sees. */
    const graph = resolveGraph(
      '/a/wolf.drs',
      'import { Dog } from "./dog"\n',
      mapHost({ '/a/dog.drs': 'data Dog {\n' }),
    );
    expect(graph.diagnostics[0].file).toBe('/a/wolf.drs');
  });

  it('visits a module reached twice only once', () => {
    const files = {
      '/a/dog.drs': DOG,
      '/a/mid.drs': 'import { Dog } from "./dog"\n',
    };
    const graph = resolveGraph(
      '/a/wolf.drs',
      'import { Dog } from "./dog"\nimport { Dog } from "./mid"\n',
      mapHost(files),
    );
    expect(graph.modules.size).toBe(3);
  });

  it('records where each import resolved to, so a caller need not resolve again', () => {
    const graph = resolveGraph(
      '/a/wolf.drs',
      'import { Dog } from "./dog"\n',
      mapHost({ '/a/dog.drs': DOG }),
    );
    expect(graph.modules.get('/a/wolf.drs')?.imports).toEqual([
      { specifier: './dog', id: '/a/dog.drs', span: { start: 0, end: 27 } },
    ]);
  });

  it('terminates on a cycle rather than walking it forever', () => {
    const files = {
      '/a/a.drs': 'import { b } from "./b"\n',
      '/a/b.drs': 'import { a } from "./a"\n',
    };
    const graph = resolveGraph('/a/a.drs', files['/a/a.drs'], mapHost(files));
    expect(graph.modules.size).toBe(2);
  });
});

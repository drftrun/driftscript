import { describe, expect, it } from 'vitest';
import { compileDriftScript } from '../index.ts';
import { createRegistry, defineCapability } from '../../registry/capability.ts';
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

const registry = () => {
  const r = createRegistry();
  r.add(
    defineCapability({
      module: 'drift/audio',
      name: 'play',
      signature: 'fn(slot: String) -> void',
      params: [{ name: 'slot', type: 'String' }],
      returns: 'void',
      effects: ['audio.write'],
      deterministic: false,
      doc: 'Play a sound.',
      implementation: 'AudioGraph.play',
    }),
  );
  return r;
};

const compile = (files: Record<string, string>, root: string) =>
  compileDriftScript(files[root], {
    filename: root,
    mode: 'development',
    registry: registry(),
    host: mapHost(files),
  });

const BARKS = 'import { play } from "drift/audio"\n\nfn bark() {\n    audio.play("bark")\n}\n';

describe('effects across a module boundary', () => {
  /**
   * The one that matters: an annotation is a claim the checker verifies, and `audio.write` reached
   * through an import is still `audio.write`. An inference that stopped at the file boundary would
   * pass this — and would make `@deterministic` mean "calls nothing impure *in this file*", which is
   * not a guarantee anybody could use.
   */
  it('carries an imported function’s effects to its caller', () => {
    const result = compile(
      {
        '/a/dog.drs': BARKS,
        '/a/wolf.drs': 'import { bark } from "./dog"\n\n@deterministic\nfn howl() {\n    bark()\n}\n',
      },
      '/a/wolf.drs',
    );
    expect(result.diagnostics.map((d) => d.code)).toContain('DS0261');
  });

  it('names the capability the import reached, not only the effect', () => {
    const result = compile(
      {
        '/a/dog.drs': BARKS,
        '/a/wolf.drs': 'import { bark } from "./dog"\n\n@deterministic\nfn howl() {\n    bark()\n}\n',
      },
      '/a/wolf.drs',
    );
    /* "has audio.write" sends a reader looking for which call did it, across two files this time. */
    expect(result.diagnostics[0].message).toContain('audio.write');
  });

  it('carries them through a chain of two imports', () => {
    const result = compile(
      {
        '/a/dog.drs': BARKS,
        '/a/mid.drs': 'import { bark } from "./dog"\n\nfn noise() {\n    bark()\n}\n',
        '/a/wolf.drs': 'import { noise } from "./mid"\n\n@pure\nfn howl() {\n    noise()\n}\n',
      },
      '/a/wolf.drs',
    );
    expect(result.diagnostics.map((d) => d.code)).toContain('DS0260');
  });

  it('leaves a caller of a pure imported function alone', () => {
    /* The negative control. Without it the test above passes for an inference that marks every
       imported call impure, which would make `@pure` unusable across files. */
    const result = compile(
      {
        '/a/dog.drs': 'fn twice(n: f32) -> f32 {\n    return n + n\n}\n',
        '/a/wolf.drs': 'import { twice } from "./dog"\n\n@pure\nfn go(n: f32) -> f32 {\n    return twice(n)\n}\n',
      },
      '/a/wolf.drs',
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('settles a cycle rather than recursing forever', () => {
    const result = compile(
      {
        '/a/a.drs': 'import { bee } from "./b"\n\nfn ay() {\n    bee()\n}\n',
        '/a/b.drs': 'import { ay } from "./a"\n\nfn bee() {\n    ay()\n}\n',
      },
      '/a/a.drs',
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('carries an effect all the way round a cycle', () => {
    /*
     * `ay` calls `bee` calls `barks`, and `bee` calls back into `ay`. Neither module's effect set is
     * final until both stop changing, which is the whole reason this is a fixed point rather than a
     * walk. A single pass in either order leaves one of them short.
     */
    const result = compile(
      {
        '/a/dog.drs': BARKS,
        '/a/a.drs':
          'import { bee } from "./b"\n\n@deterministic\nfn ay() {\n    bee()\n}\n',
        '/a/b.drs':
          'import { bark } from "./dog"\n\nfn bee() {\n    bark()\n}\n',
      },
      '/a/a.drs',
    );
    expect(result.diagnostics.map((d) => d.code)).toContain('DS0261');
  });
});

import { describe, expect, it } from 'vitest';
import { defineTarget } from './manifest.ts';
import { type LinkResult, linkCapabilities } from './link.ts';
import { compileDriftScript, singleFileHost } from '../compiler/index.ts';

const spans = new Map([['drift/animation', { start: 7, end: 24 }]]);

const refusalsOf = (result: LinkResult) => {
  if (result.linked) throw new Error('expected a refusal');
  return result.diagnostics;
};

describe('the linker', () => {
  it('links a module the target provides', () => {
    const target = defineTarget('full', ['drift/animation']);
    expect(linkCapabilities(['drift/animation'], target, spans, 'a.drs')).toEqual({ linked: true });
  });

  it('links a std module against a target that provides nothing', () => {
    expect(linkCapabilities(['std/math'], defineTarget('web-min', []), new Map(), 'a.drs')).toEqual({
      linked: true,
    });
  });

  it('links a module with no requirements at all', () => {
    expect(linkCapabilities([], defineTarget('web-min', []), new Map(), 'a.drs')).toEqual({
      linked: true,
    });
  });

  it('refuses an unprovided module with the module, the target and the reason in words', () => {
    const [diagnostic] = refusalsOf(
      linkCapabilities(['drift/animation'], defineTarget('web-min', []), spans, 'a.drs'),
    );
    expect(diagnostic.code).toBe('DS0301');
    expect(diagnostic.message).toContain('drift/animation');
    expect(diagnostic.message).toContain('web-min');
    expect(diagnostic.message).toContain('target manifest');
    expect(diagnostic.start).toBe(7);
  });

  it('says nothing provides a module yet, rather than blaming the language', () => {
    const [diagnostic] = refusalsOf(
      linkCapabilities(['drift/network'], defineTarget('web-min', []), new Map(), 'a.drs'),
    );
    expect(diagnostic.message).toContain('no host provides it yet');
    expect(diagnostic.message).toContain('links when a host implements it');
  });

  it('tells a missing manifest entry apart from a missing provider', () => {
    const target = defineTarget('web-min', []);
    const [wired] = refusalsOf(linkCapabilities(['drift/animation'], target, spans, 'a.drs'));
    const [unwired] = refusalsOf(linkCapabilities(['drift/network'], target, new Map(), 'a.drs'));

    expect(wired.message).toContain('This host provides it');
    expect(unwired.message).not.toContain('This host provides it');
    expect(unwired.message).toContain('no host provides it yet');
  });

  it('reports every unprovided module rather than the first', () => {
    const refusals = refusalsOf(
      linkCapabilities(
        ['drift/animation', 'drift/network'],
        defineTarget('web-min', []),
        new Map(),
        'a.drs',
      ),
    );
    expect(refusals).toHaveLength(2);
  });

  it('reports refusals in the order a reader meets them in the file', () => {
    const refusals = refusalsOf(
      linkCapabilities(
        ['drift/network', 'drift/animation'],
        defineTarget('web-min', []),
        new Map(),
        'a.drs',
      ),
    );
    expect(refusals[0].message).toContain('drift/network');
    expect(refusals[1].message).toContain('drift/animation');
  });

  it('reports at the top of the file when it has no span, rather than inventing one', () => {
    const [diagnostic] = refusalsOf(
      linkCapabilities(['drift/animation'], defineTarget('web-min', []), new Map(), 'a.drs'),
    );
    expect(diagnostic.start).toBe(0);
    expect(diagnostic.end).toBe(0);
  });
});

describe('a capability required through an imported file', () => {
  const files: Record<string, string> = {
    '/a/dog.drs':
      'import { play } from "drift/audio"\n\nfn bark() {\n    audio.play("b")\n}\n',
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

  const WOLF = 'import { bark } from "./dog"\n\nfn go() {\n    bark()\n}\n';

  const compile = (manifest: ReturnType<typeof defineTarget>) =>
    compileDriftScript(WOLF, { filename: '/a/wolf.drs', host, mode: 'development', manifest });

  it('requires a capability an imported file requires', () => {
    /* Without this a target could link `wolf.drs` and then fail at runtime inside `dog.drs`, which
       is the linker declining to answer the question it exists for. */
    const result = compile(defineTarget('web-min', []));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['DS0301']);
  });

  it('names the file that pulled the requirement in', () => {
    /*
     * Without the clause a consumer reads "`drift/audio` is not provided" against a file that never
     * mentions audio, and goes looking for an import that is not there.
     */
    const message = compile(defineTarget('web-min', [])).diagnostics[0].message;
    expect(message).toContain('drift/audio');
    expect(message).toContain('./dog');
  });

  it('links when the target does provide it', () => {
    expect(compile(defineTarget('full', ['drift/audio'])).diagnostics).toEqual([]);
  });

  it('does not say "required through" for a capability the file imports directly', () => {
    /* The clause is only informative where a reader cannot see the import. On a direct one it is
       noise, and noise in a diagnostic is what teaches people to stop reading them. */
    const result = compileDriftScript(
      'import { play } from "drift/audio"\n\nfn go() {\n    audio.play("b")\n}\n',
      {
        filename: '/a/w.drs',
        host: singleFileHost(),
        mode: 'development',
        manifest: defineTarget('web-min', []),
      },
    );
    expect(result.diagnostics[0].message).not.toContain('through');
  });

  it('reports an unshipped module reached through an import as unshipped, not as unlisted', () => {
    /* The two refusals say different things and send a reader to different places. Reaching one
       through an import must not flatten them together. */
    files['/a/ecs.drs'] = 'import { send } from "drift/network"\n\nfn find() {\n    network.send(1)\n}\n';
    const result = compileDriftScript(
      'import { find } from "./ecs"\n\nfn go() {\n    find()\n}\n',
      {
        filename: '/a/wolf.drs',
        host,
        mode: 'development',
        manifest: defineTarget('web-min', []),
      },
    );
    expect(result.diagnostics[0].message).toContain('no host provides it yet');
    expect(result.diagnostics[0].message).toContain('./ecs');
  });
});

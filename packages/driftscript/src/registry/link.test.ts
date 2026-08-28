import { describe, expect, it } from 'vitest';
import { defineTarget } from './manifest.ts';
import { createRegistry, defineCapability } from './capability.ts';
import { SPECIFIED_MODULES, type LinkResult, linkCapabilities } from './link.ts';
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

/**
 * A host that describes one module and not the other, which is what tells the two refusals apart.
 *
 * Built here rather than hardcoded in the linker, which is the change these tests are about: the
 * distinction used to come from a `Set` of one host's unshipped track names living inside a package
 * that may not know a host exists.
 */
const describing = (...modules: readonly string[]) => {
  const r = createRegistry();
  for (const module of modules) {
    r.add(
      defineCapability({
        module,
        name: 'probe',
        signature: 'fn() -> void',
        params: [],
        returns: 'void',
        effects: ['pure'],
        deterministic: true,
        doc: 'A capability, so the module is one this host describes.',
        implementation: `${module}.probe`,
      }),
    );
  }
  return r;
};

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

  it('says nothing here implements a module, rather than blaming the language', () => {
    /* The claim narrowed from "no host provides it" to "nothing this host describes implements it",
       and the narrower one is the only one knowable: a language cannot speak for hosts it has never
       been shown. */
    const [diagnostic] = refusalsOf(
      linkCapabilities(
        ['drift/network'],
        defineTarget('web-min', []),
        new Map(),
        'a.drs',
        new Map(),
        describing('drift/animation'),
      ),
    );
    expect(diagnostic.message).toContain('nothing this host describes implements it');
    expect(diagnostic.message).toContain('links when a host implements it');
  });

  it('claims neither when no host was configured', () => {
    /*
     * The language-server and first-look path. With no registry the linker knows the manifest and
     * nothing else, so it says only what the manifest says — where the hardcoded list let it assert
     * "this host provides it" from a name's absence, about a host it had never seen.
     */
    const [diagnostic] = refusalsOf(
      linkCapabilities(['drift/network'], defineTarget('web-min', []), new Map(), 'a.drs'),
    );
    expect(diagnostic.message).toContain('drift/network');
    /* It still says the surface is specified — that is language knowledge and does not need a host
       — and stops short of claiming anything about who implements it. */
    expect(diagnostic.message).toContain('The module is specified and your file is valid');
    expect(diagnostic.message).not.toContain('This host describes it');
    expect(diagnostic.message).not.toContain('nothing this host describes');
  });

  it('tells a missing manifest entry apart from a missing provider, from the registry', () => {
    const target = defineTarget('web-min', []);
    const registry = describing('drift/animation');
    const [wired] = refusalsOf(
      linkCapabilities(['drift/animation'], target, spans, 'a.drs', new Map(), registry),
    );
    const [unwired] = refusalsOf(
      linkCapabilities(['drift/network'], target, new Map(), 'a.drs', new Map(), registry),
    );

    expect(wired.message).toContain('This host describes it');
    expect(unwired.message).not.toContain('This host describes it');
    expect(unwired.message).toContain('nothing this host describes implements it');
  });

  it('needs no release when a host ships a module, which is the point of asking the registry', () => {
    /*
     * **The coupling this removed.** The distinction used to come from a list inside the language,
     * so a host shipping a track had to wait for a language release before it could bind the module
     * — and the host's own suite asserted the two lists agreed, in both directions. Registering the
     * capability is now the whole of it.
     */
    const target = defineTarget('web-min', []);
    const before = refusalsOf(
      linkCapabilities(['drift/navigation'], target, new Map(), 'a.drs', new Map(), describing()),
    );
    expect(before[0].message).toContain('nothing this host describes implements it');

    const after = refusalsOf(
      linkCapabilities(
        ['drift/navigation'],
        target,
        new Map(),
        'a.drs',
        new Map(),
        describing('drift/navigation'),
      ),
    );
    expect(after[0].message).toContain('This host describes it');
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

  it('reports a module reached through an import as specified, not as unlisted', () => {
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
    expect(result.diagnostics[0].message).toContain('The module is specified and your file is valid');
    expect(result.diagnostics[0].message).toContain('./ecs');
  });
});

describe('the catalogue of specified surfaces', () => {
  it('names the near module when one is misspelled', () => {
    /*
     * **New, and it replaces advice that was wrong.** A typo used to fall into "this host provides
     * it — add it to the target manifest", because the old list held only *unshipped* names and a
     * misspelling was in neither set. So a reader was told to add a module that does not exist to a
     * manifest, and the next refusal was the same one.
     */
    const [diagnostic] = refusalsOf(
      linkCapabilities(['drift/nagivation'], defineTarget('web-min', []), new Map(), 'a.drs'),
    );
    expect(diagnostic.message).toContain('not a module this language specifies');
    expect(diagnostic.message).toContain('Did you mean `drift/navigation`?');
  });

  it('says nothing about a near name when there is none', () => {
    const [diagnostic] = refusalsOf(
      linkCapabilities(['drift/madeup'], defineTarget('web-min', []), new Map(), 'a.drs'),
    );
    expect(diagnostic.message).toContain('not a module this language specifies');
    expect(diagnostic.message).not.toContain('Did you mean');
  });

  it('keeps telling an author that an unbuilt surface is real, which is what it is for', () => {
    /*
     * The half worth keeping from the list this replaced. A script may be written against a surface
     * nothing implements, and the refusal has to say the file is fine — otherwise the language
     * reads as broken and the author trims their design to what shipped, which is the outcome the
     * whole linking design exists to prevent.
     */
    const [diagnostic] = refusalsOf(
      linkCapabilities(['drift/behavior'], defineTarget('web-min', []), new Map(), 'a.drs'),
    );
    expect(diagnostic.message).toContain('The module is specified and your file is valid');
  });

  it('lists every surface a host could bind, and never shrinks as one ships', () => {
    /*
     * The property that removed the release coupling. The set this replaced held *unshipped* names
     * and had to lose one every time a host built it — so a host could not bind a module until the
     * language cut a release, and the host's own suite asserted the two agreed. This one contains
     * the built and the unbuilt alike, so shipping a track changes nothing here.
     */
    for (const shipped of ['drift/ecs', 'drift/audio', 'drift/physics', 'drift/chemistry']) {
      expect(SPECIFIED_MODULES).toContain(shipped);
    }
    for (const unbuilt of ['drift/navigation', 'drift/behavior', 'drift/terrain']) {
      expect(SPECIFIED_MODULES).toContain(unbuilt);
    }
  });
});


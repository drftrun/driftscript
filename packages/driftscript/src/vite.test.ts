import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type HotUpdateModule, driftScript } from './vite.ts';
import { defineTarget } from './registry/manifest.ts';
import { createRegistry, defineCapability } from './registry/capability.ts';
import { type SerializedRegistry, serializeRegistry, targetFromCapabilities } from './registry/serialize.ts';

const PULSE = 'data P {\n    a: f32 = 0\n}\n';

function audioRegistry() {
  const registry = createRegistry();
  registry.add(
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
  return registry;
}

/** A module node in the shape the plugin reads, which is two fields of Vite's. */
/* A transform context that records nothing. The plugin declares `addWatchFile` as required rather
   than optional, so every call site says what it does with a dependency — and a bundler always
   supplies one. */
const ignoringWatches = { addWatchFile: () => {} };

function node(id: string, importers: HotUpdateModule[] = []): HotUpdateModule {
  return { id, importers: new Set(importers) };
}

describe('the Vite plugin', () => {
  it('transforms a .drs id and passes everything else through', () => {
    const plugin = driftScript();
    expect(plugin.transform.call(ignoringWatches, PULSE, '/x/p.drs')).toMatchObject({
      code: expect.stringContaining('export function createP'),
    });
    expect(plugin.transform.call(ignoringWatches, 'export const a = 1', '/x/p.ts')).toBeNull();
  });

  it('returns a map alongside the code', () => {
    const result = driftScript().transform.call(ignoringWatches, PULSE, '/x/p.drs');
    expect(result?.map.version).toBe(3);
  });

  it('transforms a .drs id that a bundler appended a query to', () => {
    expect(driftScript().transform.call(ignoringWatches, PULSE, '/x/p.drs?import&t=1')).not.toBeNull();
  });

  it('runs before other transforms, because a .drs file is not JavaScript yet', () => {
    expect(driftScript().enforce).toBe('pre');
  });

  it('throws on a compile failure, where the compiler returns diagnostics', () => {
    expect(() => driftScript().transform.call(ignoringWatches, 'data P {\n    a: f32 = "x"\n}\n', '/x/p.drs')).toThrow(
      /DS0202/,
    );
  });

  it('puts every diagnostic in the thrown message, not only the first', () => {
    try {
      driftScript().transform.call(ignoringWatches, 'data P {\n    a: f32 = "x"\n    b: f32 = "y"\n}\n', '/x/p.drs');
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message.match(/DS0202/g)).toHaveLength(2);
    }
  });

  it('refuses an unprovided module when a manifest is configured', () => {
    const plugin = driftScript({ manifest: defineTarget('web-min', []) });
    expect(() =>
      plugin.transform.call(ignoringWatches, `import { play } from "drift/audio"\n\n${PULSE}`, '/x/p.drs'),
    ).toThrow(/DS0301/);
  });

  it('links anything when no manifest is configured, which is the first-look path', () => {
    const plugin = driftScript();
    expect(
      plugin.transform.call(ignoringWatches, `import { play } from "drift/audio"\n\n${PULSE}`, '/x/p.drs'),
    ).not.toBeNull();
  });
});

describe('the plugin and a hot update', () => {
  const BODY = 'data P {\n    a: f32 = 0\n}\n\nfn update(p: mut P, dt: f32) {\n    p.a += %\n}\n';

  it('updates the changed module alone when only a body changed', async () => {
    const plugin = driftScript();
    const drs = node('/x/p.drs', [node('/x/sub.drs')]);

    plugin.transform.call(ignoringWatches, BODY.replace('%', 'dt'), '/x/p.drs');
    const affected = await plugin.hotUpdate({
      file: '/x/p.drs',
      modules: [drs],
      read: async () => BODY.replace('%', 'dt * 2'),
    });

    expect(affected?.map((m) => m.id)).toEqual(['/x/p.drs']);
  });

  it('takes a `.drs` importer with it when the interface moved', async () => {
    /* A subtype inlines its base's defaults, so a base whose interface moved leaves it emitting the
       old literal. That file has to be recompiled and re-executed. */
    const plugin = driftScript();
    const drs = node('/x/p.drs', [node('/x/sub.drs')]);

    plugin.transform.call(ignoringWatches, BODY.replace('%', 'dt'), '/x/p.drs');
    const affected = await plugin.hotUpdate({
      file: '/x/p.drs',
      modules: [drs],
      read: async () => BODY.replace('a: f32 = 0', 'a: f32 = 0\n    b: f32 = 1').replace('%', 'dt'),
    });

    expect(affected?.map((m) => m.id)).toEqual(['/x/p.drs', '/x/sub.drs']);
  });

  it('leaves an application importer alone, so its accept handler can migrate', async () => {
    /*
     * This used to invalidate `main.ts` too, on the reasoning that `patchModule` refused a shape
     * change. Phase 5 made that false. Re-executing the importer rebuilds the state from its
     * constructor, destroying exactly what the migration exists to carry across — measured on a
     * live server, where adding a field showed the field arriving and the page silently restarting
     * with `reloads` still reading zero.
     */
    const plugin = driftScript();
    const drs = node('/x/p.drs', [node('/x/main.ts')]);

    plugin.transform.call(ignoringWatches, BODY.replace('%', 'dt'), '/x/p.drs');
    const affected = await plugin.hotUpdate({
      file: '/x/p.drs',
      modules: [drs],
      read: async () => BODY.replace('a: f32 = 0', 'a: f32 = 0\n    b: f32 = 1').replace('%', 'dt'),
    });

    expect(affected?.map((m) => m.id)).toEqual(['/x/p.drs']);
  });

  it('leaves the importers alone while the file does not parse', async () => {
    const plugin = driftScript();
    const drs = node('/x/p.drs', [node('/x/sub.drs')]);

    plugin.transform.call(ignoringWatches, BODY.replace('%', 'dt'), '/x/p.drs');
    const affected = await plugin.hotUpdate({
      file: '/x/p.drs',
      modules: [drs],
      read: async () => 'data P {\n',
    });

    /* A file mid-save is not a reason to reset a running page. The transform is what reports the
       error, when the browser asks for the module. */
    expect(affected?.map((m) => m.id)).toEqual(['/x/p.drs']);
  });

  it('answers the same for every environment, because a hot update does not consume the move', async () => {
    /*
     * A bundler calls `hotUpdate` once per environment. An earlier version recorded the new
     * interface here, so the first call saw the move and every later one saw nothing to do. Found
     * by instrumenting the hook against a live dev server, which is also where the two calls per
     * change were first visible at all.
     */
    const plugin = driftScript();
    const drs = node('/x/p.drs', [node('/x/sub.drs')]);
    plugin.transform.call(ignoringWatches, BODY.replace('%', 'dt'), '/x/p.drs');

    const next = BODY.replace('a: f32 = 0', 'a: f32 = 0\n    b: f32 = 1').replace('%', 'dt');
    const first = await plugin.hotUpdate({ file: '/x/p.drs', modules: [drs], read: async () => next });
    const second = await plugin.hotUpdate({ file: '/x/p.drs', modules: [drs], read: async () => next });

    expect(first?.map((m) => m.id)).toEqual(['/x/p.drs', '/x/sub.drs']);
    expect(second?.map((m) => m.id)).toEqual(first?.map((m) => m.id));
  });

  it('ignores a file that is not a .drs', async () => {
    expect(await driftScript().hotUpdate({ file: '/x/main.ts', modules: [], read: async () => '' }))
      .toBeUndefined();
  });
});

describe('the plugin and the registry', () => {
  /*
   * Without a registry the compiler infers no effects and checks no annotation, so `@deterministic`
   * in a production build was a claim nothing verified. The compiler's own documentation said to
   * configure one here, and there was no option to configure.
   */
  it('checks a determinism annotation against the capabilities it is given', () => {
    const source =
      'import { play } from "drift/audio"\n\n@deterministic\nfn tick() {\n    audio.play("x")\n}\n';
    expect(() => driftScript({ registry: audioRegistry() }).transform.call(ignoringWatches, source, '/x/p.drs')).toThrow(
      /DS0261/,
    );
  });

  it('verifies nothing when given no registry, which is the first-look path', () => {
    const source =
      'import { play } from "drift/audio"\n\n@deterministic\nfn tick() {\n    audio.play("x")\n}\n';
    expect(driftScript().transform.call(ignoringWatches, source, '/x/p.drs')).not.toBeNull();
  });

  /*
   * A warning is not a build failure.
   *
   * The guard here was `result.diagnostics.length > 0`, which was right while every diagnostic was
   * an error. `compileDriftScript` was corrected for exactly this and the plugin was not, so the
   * defect survived one layer up — unreachable only because the plugin had no way to be given a
   * registry, and reachable the moment it did.
   */
  it('emits code for a file whose only diagnostic is a warning', () => {
    const source = 'import { play } from "drift/audio"\n\nfn nothing() {\n}\n';
    const result = driftScript({ registry: audioRegistry() }).transform.call(ignoringWatches, source, '/x/p.drs');
    expect(result?.code).toContain('export function nothing');
  });
});

describe('the plugin resolving files from disk', () => {
  /*
   * A real directory, because this task's whole subject is resolving from one. A fake host here
   * would test the plugin against a seam the plugin does not have.
   */
  const dir = mkdtempSync(path.join(tmpdir(), 'drs-'));
  writeFileSync(
    path.join(dir, 'dog.drs'),
    'data Dog {\n    name: String = "rex"\n}\n\nfn rest(d: mut Dog) {\n    d.name = "x"\n}\n',
  );

  /* Uses `Dog` only as a base, so nothing is imported as a value and nothing is emitted as an
     `import`. This is exactly the case a bundler cannot see on its own. */
  const TYPE_ONLY = 'import { Dog } from "./dog"\n\ndata Wolf : Dog {\n    packSize: i32 = 0\n}\n';
  const CALLS = 'import { Dog, rest } from "./dog"\n\nfn go(d: mut Dog) {\n    rest(d)\n}\n';

  const transform = (source: string, watched: string[] = []) =>
    driftScript().transform.call(
      { addWatchFile: (id: string) => watched.push(id) },
      source,
      path.join(dir, 'wolf.drs'),
    );

  it('resolves a relative import from the filesystem', () => {
    const result = transform(CALLS);
    expect(result).not.toBeNull();
    expect(result?.code).toContain('rest');
  });

  it('inlines a base default read from the other file', () => {
    expect(transform(TYPE_ONLY)?.code).toContain('name: "rex"');
  });

  it('declares every resolved file import as a watched dependency', () => {
    const watched: string[] = [];
    transform(TYPE_ONLY, watched);
    expect(watched).toEqual([path.join(dir, 'dog.drs')]);
  });

  it('emits no import for that file, which is why the watch is the only thing holding the edge', () => {
    /*
     * Keeps the test above from being deleted as belt-and-braces. A type-only import produces no
     * ESM edge at all — a record emits `createDog`, not `Dog` — so without `addWatchFile` a change
     * to the base would not rebuild the subtype, and the subtype would keep inlining the old
     * defaults. Stale values, no error.
     */
    expect(transform(TYPE_ONLY)?.code).not.toContain('import');
  });

  it('still watches a file it does emit an import for', () => {
    const watched: string[] = [];
    transform(CALLS, watched);
    expect(watched).toEqual([path.join(dir, 'dog.drs')]);
  });

  it('refuses a relative import that does not resolve, in words', () => {
    expect(() => transform('import { Cat } from "./missing"\n')).toThrow(/DS0501/);
  });

  it('recompiles a subtype after its base changed, even though its own source did not', async () => {
    /*
     * The defect this exists for, found on a live server rather than here. `addWatchFile` worked and
     * Vite re-ran the transform; the plugin's own compile memo is keyed on a module's own source, so
     * it handed back the previous answer and the subtype went on inlining the old default. The
     * feature looked broken while the mechanism was fine.
     */
    const base = path.join(dir, 'base.drs');
    const sub = path.join(dir, 'sub.drs');
    writeFileSync(base, 'data Base {\n    speed: f32 = 1\n}\n');
    const SUB = 'import { Base } from "./base"\n\ndata Sub : Base {\n    extra: f32 = 0\n}\n';

    const plugin = driftScript();
    expect(plugin.transform.call(ignoringWatches, SUB, sub)?.code).toContain('speed: 1');

    writeFileSync(base, 'data Base {\n    speed: f32 = 5\n}\n');
    await plugin.hotUpdate({ file: base, modules: [], read: async () => 'data Base {\n    speed: f32 = 5\n}\n' });

    /* Same source for `sub.drs`, different output, because its base moved. */
    expect(plugin.transform.call(ignoringWatches, SUB, sub)?.code).toContain('speed: 5');
  });

  it('watches nothing for a file with no relative imports', () => {
    const watched: string[] = [];
    transform('data P {\n    a: f32 = 0\n}\n', watched);
    expect(watched).toEqual([]);
  });
});


describe('a bundler config can be given capabilities as data', () => {
  /*
   * **A bundler config is loaded by Node, and Node cannot import an arbitrary host.** A host whose
   * packages use extensionless relative imports resolves under a bundler and nowhere else, so
   * `import { hostRegistry } from 'my-engine'` inside a `vite.config.ts` fails on the first
   * extensionless `./registry` inside it.
   *
   * The `registry` option's own documentation called passing one "one import", which sent every
   * consumer down a path nobody could take — and the result was **silent**: a build with no
   * registry infers no effects and checks no annotation, so `@deterministic` was decoration in
   * every real project rather than in none. Reported by a consumer who read the resolution error
   * correctly and was told the engine could not do it.
   *
   * The mechanism was already here. A registry describes and never invokes, so it crosses a process
   * boundary as JSON — which is how the language server reads one, for exactly this reason.
   */
  const ignoring = { addWatchFile: () => {} };
  const capabilities = (): SerializedRegistry => serializeRegistry(audioRegistry());
  const CALL = 'import { play } from "drift/audio"\n\nfn f() {\n    audio.play()\n}\n';

  it('checks a capability call against parsed capability data', () => {
    const plugin = driftScript({ capabilities: capabilities() });
    /* Arity against the real signature, which only a live registry can check. */
    expect(() => plugin.transform.call(ignoring, CALL, '/x/p.drs')).toThrow(/DS0262/);
  });

  it('reads a capability file from a path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'driftscript-caps-'));
    const file = path.join(dir, 'capabilities.json');
    writeFileSync(file, JSON.stringify(capabilities()));
    try {
      const plugin = driftScript({ capabilities: file });
      expect(() => plugin.transform.call(ignoring, CALL, '/x/p.drs')).toThrow(/DS0262/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the path it could not read', () => {
    expect(() => driftScript({ capabilities: '/no/such/capabilities.json' })).toThrow(
      /\/no\/such\/capabilities\.json/,
    );
  });

  it('refuses both `registry` and `capabilities` rather than picking one', () => {
    /* Two descriptions of what a host provides, and a build silently using the one nobody meant. */
    expect(() =>
      driftScript({ capabilities: capabilities(), registry: audioRegistry() }),
    ).toThrow(/both/);
  });

  it('reads the file once when the plugin is made, not once per transform', () => {
    /*
     * A project has hundreds of `.drs` files. Reading and validating a capability file for each is
     * the same work several hundred times — and a file that changed mid-build would give two files
     * in one build different answers about what the host provides.
     */
    const dir = mkdtempSync(path.join(tmpdir(), 'driftscript-caps-'));
    const file = path.join(dir, 'capabilities.json');
    writeFileSync(file, JSON.stringify(capabilities()));
    const plugin = driftScript({ capabilities: file });
    rmSync(dir, { recursive: true, force: true });

    /* The file is gone and the plugin still knows the host, because it read it when it was made. */
    expect(() => plugin.transform.call(ignoring, CALL, '/x/p.drs')).toThrow(/DS0262/);
  });

  it('still verifies nothing when given neither, which is the first-look path', () => {
    expect(driftScript().transform.call(ignoring, CALL, '/x/p.drs')).not.toBeNull();
  });
});

describe('a target built from capability data', () => {
  it('provides every module the data describes, once each', () => {
    /* So a consumer wanting all of them does not write the list out — a second copy that goes
       stale the first time a host grows a surface. */
    const target = targetFromCapabilities(serializeRegistry(audioRegistry()), 'mine');
    expect(target.name).toBe('mine');
    expect(target.provides).toEqual(['drift/audio']);
  });
});

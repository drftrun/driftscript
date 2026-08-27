import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost} from '../compiler/index.ts';
import { bindHost, disposeModule, loadModule } from './module.ts';
import { patchModule } from './hot.ts';

const V1 =
  'data PulseState {\n    phase: f32 = 0\n}\n\nfn update(state: mut PulseState, dt: f32) {\n    state.phase += dt\n}\n';
/* The same interface, a different body: the edit hot reload exists for. */
const V2 =
  'data PulseState {\n    phase: f32 = 0\n}\n\nfn update(state: mut PulseState, dt: f32) {\n    state.phase += dt\n    state.phase += dt\n}\n';
/* A record that gained a field: the edit hot reload must refuse until migration exists. */
const V3 =
  'data PulseState {\n    phase: f32 = 0\n    amplitude: f32 = 1\n}\n\nfn update(state: mut PulseState, dt: f32) {\n    state.phase += dt\n}\n';
/* A record that vanished. */
const V4 = 'data Other {\n    a: f32 = 0\n}\n';

const compileAndImport = async (source: string) => {
  const { code, diagnostics } = compileDriftScript(source, {
    filename: 'p.drs',
    host: singleFileHost(),
    mode: 'development',
  });
  expect(diagnostics).toEqual([]);
  return (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${btoa(code)}`
  )) as Record<string, unknown>;
};

const load = async (source: string) => loadModule(await compileAndImport(source));

type Pulse = { phase: number };
const create = (module: { exports: Record<string, unknown> }) =>
  (module.exports.createPulseState as () => Pulse)();
const update = (module: { exports: Record<string, unknown> }, state: Pulse, dt: number) =>
  (module.exports.update as (s: Pulse, dt: number) => void)(state, dt);

describe('hot reload', () => {
  it('step 7: replaces a function body', async () => {
    const module = await load(V1);
    const state = create(module);
    update(module, state, 1);
    expect(state.phase).toBe(1);

    expect(patchModule(module, await compileAndImport(V2))).toEqual({ patched: true });

    update(module, state, 1);
    expect(state.phase).toBe(3);
  });

  it('step 8: the state instance survives the reload', async () => {
    const module = await load(V1);
    const state = create(module);
    update(module, state, 0.5);

    patchModule(module, await compileAndImport(V2));

    expect(state.phase).toBe(0.5);
  });

  it('a caller holding the module through exports sees the new function', async () => {
    const module = await load(V1);
    const before = module.exports.update;
    patchModule(module, await compileAndImport(V2));
    expect(module.exports.update).not.toBe(before);
  });

  it('adds a field to a live record, keeping what was already there', async () => {
    /*
     * Task 15 refused this in words, and that was the honest state until field ids were stable.
     * Now `amplitude` arrives with its default and `phase` keeps the half-second it had reached —
     * which is the whole difference between a reload and a restart.
     */
    const module = await load(V1);
    const state = create(module);
    update(module, state, 0.5);

    const result = patchModule(module, await compileAndImport(V3), { PulseState: [state] });

    expect(result).toEqual({ patched: true });
    expect(state.phase).toBe(0.5);
    expect((state as unknown as { amplitude: number }).amplitude).toBe(1);
  });

  it('refuses a shape change when the caller did not say what it holds', async () => {
    /*
     * The runtime keeps no instances — a record is a plain object a consumer owns, which is what
     * makes the shape comparison and the zero-allocation constructor possible at all. So it cannot
     * know whether any exist, and swapping in code that reads a field the instances do not have
     * would surface as an `undefined` in arithmetic several frames later.
     */
    const module = await load(V1);
    const result = patchModule(module, await compileAndImport(V3));

    expect(result.patched).toBe(false);
    if (result.patched) throw new Error('expected a refusal');
    expect(result.reason).toContain('PulseState');
    expect(result.reason).toContain('empty record');
  });

  it('accepts a shape change from a caller that holds nothing', async () => {
    const module = await load(V1);
    expect(patchModule(module, await compileAndImport(V3), {})).toEqual({ patched: true });
    expect(module.info.shapes).toEqual({ PulseState: ['phase', 'amplitude'] });
  });

  it('refuses a field whose type changed, and writes nothing', async () => {
    const retyped =
      'data PulseState {\n    phase: String = ""\n}\n\nfn touch(state: mut PulseState) {\n}\n';
    const module = await load(V1);
    const state = create(module);
    update(module, state, 0.5);

    const result = patchModule(module, await compileAndImport(retyped), { PulseState: [state] });

    expect(result.patched).toBe(false);
    if (result.patched) throw new Error('expected a refusal');
    expect(result.reason).toContain('phase');
    /* The instance untouched, and the module still on the version it belongs to. */
    expect(state.phase).toBe(0.5);
    expect(module.info.shapes).toEqual({ PulseState: ['phase'] });
  });

  it('leaves the module on its previous version when it refuses', async () => {
    const module = await load(V1);
    const state = create(module);
    patchModule(module, await compileAndImport(V3));

    update(module, state, 1);
    expect(state.phase).toBe(1);
    expect(module.info.shapes).toEqual({ PulseState: ['phase'] });
  });

  it('drops a field the new shape no longer has, rather than leaving it behind', async () => {
    /* A field left behind keeps working for code that still reads it, and the next reload inherits
       a shape nothing declares. */
    const module = await load(V3);
    const state = (module.exports.createPulseState as () => Record<string, unknown>)();

    expect(patchModule(module, await compileAndImport(V1), { PulseState: [state] })).toEqual({
      patched: true,
    });
    expect(Object.keys(state)).toEqual(['phase']);
  });

  it('refuses a patch that removes a record live instances may exist of', async () => {
    const module = await load(V1);
    const result = patchModule(module, await compileAndImport(V4));
    expect(result.patched).toBe(false);
    if (result.patched) throw new Error('expected a refusal');
    expect(result.reason).toContain('PulseState');
    expect(result.reason).toContain('orphaned');
  });

  it('accepts a patch that adds a new record without touching the old one', async () => {
    const module = await load(V1);
    const result = patchModule(module, await compileAndImport(`${V1}\ndata Extra {\n    a: f32 = 0\n}\n`));
    expect(result).toEqual({ patched: true });
    expect(module.exports.createExtra).toBeTypeOf('function');
  });

  it('releases its exports on dispose', async () => {
    const module = await load(V1);
    disposeModule(module);
    expect(Object.keys(module.exports)).toHaveLength(0);
    expect(module.disposed).toBe(true);
  });

  it('refuses to patch a disposed module rather than resurrecting it', async () => {
    const module = await load(V1);
    disposeModule(module);
    const result = patchModule(module, await compileAndImport(V2));
    expect(result.patched).toBe(false);
    if (result.patched) throw new Error('expected a refusal');
    expect(result.reason).toContain('disposed');
  });

  it('carries the module info the compiler recorded', async () => {
    const module = await load(V1);
    expect(module.info.module).toBe('p.drs');
    expect(module.info.shapes).toEqual({ PulseState: ['phase'] });
  });
});


/*
 * A patched module keeps its host bindings.
 *
 * **This was broken for as long as `__bind` has existed, and nothing noticed** — because the only
 * hot-reload demo in the repository imports no capability at all, and every test of a patch used a
 * module that binds nothing. `patchModule` re-ran `__runtime` and never `__bind`, so the first
 * capability call after any edit read a namespace that was `undefined`.
 *
 * Found by editing a `.drs` in a running browser: the page threw
 * `Cannot read properties of undefined (reading 'query')` on the frame after a save.
 */
describe('a patched module is still bound to its host', () => {
  const WITH_CAPABILITY =
    'import { play } from "drift/audio"\n\nfn ping() {\n    audio.play(1)\n}\n';
  const WITH_CAPABILITY_V2 =
    'import { play } from "drift/audio"\n\nfn ping() {\n    audio.play(2)\n}\n';

  it('calls the host after a patch, rather than a namespace that is undefined', async () => {
    const module = await load(WITH_CAPABILITY);
    const played: number[] = [];
    bindHost(module, { 'drift/audio': { play: (n: number) => played.push(n) } });

    (module.exports.ping as () => void)();
    expect(played).toEqual([1]);

    const patched = patchModule(module, await compileAndImport(WITH_CAPABILITY_V2));
    expect(patched.patched).toBe(true);

    /* The line that threw in a browser. */
    (module.exports.ping as () => void)();
    expect(played).toEqual([1, 2]);
  });

  it('leaves a module nobody bound alone', () => {
    /* A module with no capability imports has no `__bind`, and re-binding one is a no-op rather
       than an error — a consumer should not have to know which of its scripts happen to use one. */
    expect(async () => {
      const module = await load(V1);
      patchModule(module, await compileAndImport(V2));
    }).not.toThrow();
  });
});

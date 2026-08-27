import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost} from './index.ts';
import { createRegistry, defineCapability } from '../registry/capability.ts';

const PULSE =
  'data PulseState {\n    phase: f32 = 0\n}\n\nfn update(state: mut PulseState, dt: f32) {\n    state.phase += dt\n}\n';

describe('compileDriftScript', () => {
  it('compiles the pulse example to code, a map and metadata', () => {
    const result = compileDriftScript(PULSE, { filename: 'pulse.drs', host: singleFileHost(), mode: 'development' });
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('export function update');
    expect(result.map.version).toBe(3);
    expect(result.metadata.module).toBe('pulse.drs');
    expect(result.metadata.requires).toEqual([]);
    expect(result.metadata.interfaceHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns diagnostics and empty code rather than throwing', () => {
    const result = compileDriftScript('data P {\n    a: f32 = "x"\n}\n', {
      filename: 'a.drs',
      host: singleFileHost(),
      mode: 'development',
    });
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.code).toBe('');
  });

  it('stops at the first failing stage rather than checking a recovered tree', () => {
    const result = compileDriftScript('data P {\n', { filename: 'a.drs', host: singleFileHost(), mode: 'development' });
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => d.code.startsWith('DS01'))).toBe(true);
  });

  it('reports every type error in one pass', () => {
    const result = compileDriftScript('data P {\n    a: f32 = "x"\n    b: f32 = "y"\n}\n', {
      filename: 'a.drs',
      host: singleFileHost(),
      mode: 'development',
    });
    expect(result.diagnostics).toHaveLength(2);
  });

  it('links nothing and refuses nothing when no manifest is given', () => {
    const result = compileDriftScript(
      'import { blendTree } from "drift/animation"\n\ndata P {\n    a: f32 = 0\n}\n',
      { filename: 'a.drs', host: singleFileHost(), mode: 'development' },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.metadata.requires).toEqual(['drift/animation']);
  });

  it('gives the same interface hash for a body-only edit', () => {
    const before = compileDriftScript(PULSE, { filename: 'p.drs', host: singleFileHost(), mode: 'development' });
    const after = compileDriftScript(PULSE.replace('+= dt', '+= dt'), {
      filename: 'p.drs',
      host: singleFileHost(),
      mode: 'development',
    });
    expect(after.metadata.interfaceHash).toBe(before.metadata.interfaceHash);
  });

  it('moves the interface hash when a record gains a field', () => {
    const before = compileDriftScript(PULSE, { filename: 'p.drs', host: singleFileHost(), mode: 'development' });
    const after = compileDriftScript(PULSE.replace('phase: f32 = 0', 'phase: f32 = 0\n    amp: f32 = 1'), {
      filename: 'p.drs',
      host: singleFileHost(),
      mode: 'development',
    });
    expect(after.metadata.interfaceHash).not.toBe(before.metadata.interfaceHash);
  });

  /**
   * A warning does not stop the build, and a successful build still carries it.
   *
   * The guard was `diagnostics.length > 0` when every diagnostic was an error, and the day the
   * checker learned its first warning that line turned every warned-about file into an empty
   * module. Nothing caught it: the language server shares this function, so the build and the
   * editor agreed — and both were wrong. Asserted from both sides here.
   */
  it('emits code for a file whose only diagnostic is a warning', () => {
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

    const result = compileDriftScript(
      'import { play } from "drift/audio"\n\nfn nothing() {\n}\n',
      { filename: 'a.drs', registry, host: singleFileHost(), mode: 'development' },
    );

    expect(result.diagnostics.map((d) => d.severity)).toEqual(['warning']);
    expect(result.code).toContain('export function nothing');
    expect(result.metadata.interfaceHash).not.toBe('');
  });

  it('still stops on an error that appears beside a warning', () => {
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

    const result = compileDriftScript(
      'import { play } from "drift/audio"\n\ndata P {\n    a: f32 = "x"\n}\n',
      { filename: 'a.drs', registry, host: singleFileHost(), mode: 'development' },
    );

    expect(result.code).toBe('');
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('moves the interface hash when a module starts requiring a capability', () => {
    const before = compileDriftScript(PULSE, { filename: 'p.drs', host: singleFileHost(), mode: 'development' });
    const after = compileDriftScript(`import { play } from "drift/audio"\n\n${PULSE}`, {
      filename: 'p.drs',
      host: singleFileHost(),
      mode: 'development',
    });
    expect(after.metadata.interfaceHash).not.toBe(before.metadata.interfaceHash);
  });
});

describe('the interface hash across modules', () => {
  const host = (files: Record<string, string>) => ({
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
  });

  const WOLF = 'import { Dog } from "./dog"\n\ndata Wolf : Dog {\n    packSize: i32 = 0\n}\n';

  const wolfHashAgainst = (dog: string) =>
    compileDriftScript(WOLF, {
      filename: '/a/wolf.drs',
      mode: 'development',
      host: host({ '/a/dog.drs': dog }),
    }).metadata.interfaceHash;

  it('moves a subtype hash when its base gains a field', () => {
    /* `createWolf` inlines Dog's defaults, so a change to Dog genuinely changes what Wolf emits.
       A hash that ignored the dependency would leave every dependent of Wolf on stale code. */
    const before = wolfHashAgainst('data Dog {\n    name: String = ""\n}\n');
    const after = wolfHashAgainst('data Dog {\n    name: String = ""\n    age: i32 = 0\n}\n');
    expect(after).not.toBe(before);
  });

  it('moves it when a base default changes, because the constructor inlines the value', () => {
    const before = wolfHashAgainst('data Dog {\n    age: i32 = 1\n}\n');
    const after = wolfHashAgainst('data Dog {\n    age: i32 = 2\n}\n');
    expect(after).not.toBe(before);
  });

  it('leaves it identical when only a function body in the base module changes', () => {
    const body = 'data Dog {\n    name: String = ""\n}\n\nfn bark() -> i32 {\n    return %\n}\n';
    expect(wolfHashAgainst(body.replace('%', '2'))).toBe(wolfHashAgainst(body.replace('%', '1')));
  });

  it('moves it when an imported signature changes', () => {
    const source = 'import { rest } from "./dog"\n\nfn go() {\n    rest(1)\n}\n';
    const hashOf = (dog: string) =>
      compileDriftScript(source, {
        filename: '/a/w.drs',
        mode: 'development',
        host: host({ '/a/dog.drs': dog }),
      }).metadata.interfaceHash;
    expect(hashOf('fn rest(n: i32) {\n}\n')).not.toBe(hashOf('fn rest(n: f32) {\n}\n'));
  });

  it('terminates on a cycle rather than recursing through it', () => {
    /*
     * Hashing a module by recursing into its imports does not return when they lead back. The unit
     * is the component: every member contributes its own interface once, and the combined result is
     * what each of them carries.
     */
    const files = {
      '/a/a.drs': 'import { bee } from "./b"\n\nfn ay() {\n}\n',
      '/a/b.drs': 'import { ay } from "./a"\n\nfn bee() {\n}\n',
    };
    const result = compileDriftScript(files['/a/a.drs'], {
      filename: '/a/a.drs',
      mode: 'development',
      host: host(files),
    });
    expect(result.metadata.interfaceHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('leaves a module with no imports hashing exactly as it did alone', () => {
    /* The single-file path must not shift because the machinery for many exists. */
    const alone = compileDriftScript(PULSE, {
      filename: 'p.drs',
      mode: 'development',
      host: singleFileHost(),
    }).metadata.interfaceHash;
    expect(alone).toMatch(/^[0-9a-f]{8}$/);
    expect(alone).not.toBe('');
  });
});

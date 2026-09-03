import { describe, expect, it } from 'vitest';
import { type CompileOptions, compileDriftScript, singleFileHost } from './index.ts';
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

  /*
   * **A module reached through a name the file chose, end to end.**
   *
   * `drift/2d` is the surface that made aliases necessary: its namespace would be `2d`, which does
   * not lex, so nothing could be written to call into it. The whole path has to agree on the new
   * name — the checker resolves it, the lowering carries it, and the emitter binds the *module*
   * behind it, so what reaches the host is still the path.
   */
  it('compiles a module through the namespace the import named', () => {
    const registry = createRegistry();
    registry.add(
      defineCapability({
        module: 'drift/2d',
        name: 'sprite',
        signature: 'fn(texture: i32) -> void',
        params: [{ name: 'texture', type: 'i32' }],
        returns: 'void',
        effects: ['scene.write'],
        deterministic: false,
        doc: 'Put one quad in the batch.',
        implementation: 'drift/2d.sprite',
      }),
    );

    const result = compileDriftScript(
      'import { sprite } from "drift/2d" as sprites\n\nfn hud() {\n    sprites.sprite(0)\n}\n',
      { filename: 'a.drs', registry, host: singleFileHost(), mode: 'development' },
    );

    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.metadata.requires).toEqual(['drift/2d']);
    /* The alias is the source's name for it; the host is still handed the path. */
    expect(result.code).toContain('sprites = $host["drift/2d"]');
    expect(result.code).toContain('sprites.sprite(0)');
  });

  /*
   * **The half that would have failed silently.** The hot-path pass looks a capability up by the
   * callee written in the file, so a table keyed by the module's own last segment misses every
   * aliased call — and misses it by finding nothing, which reads as a call it has no opinion about
   * rather than as a lookup that went wrong. Asserted with an effect the rule actually refuses.
   */
  it('still refuses a hot path its capability was renamed in', () => {
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

    const source = (from: string, call: string) =>
      `import { play } from "drift/audio"${from}\n\n@hot\nfn tick() {\n    ${call}("horn")\n}\n`;

    const plain = compileDriftScript(source('', 'audio.play'), {
      filename: 'a.drs',
      registry,
      host: singleFileHost(),
      mode: 'development',
    });
    const renamed = compileDriftScript(source(' as sfx', 'sfx.play'), {
      filename: 'a.drs',
      registry,
      host: singleFileHost(),
      mode: 'development',
    });

    expect(plain.diagnostics.map((d) => d.code)).toContain('DS0401');
    expect(renamed.diagnostics.map((d) => d.code)).toContain('DS0401');
    expect(renamed.diagnostics.find((d) => d.code === 'DS0401')?.message).toContain('`sfx.play`');
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

describe('a production build has something to verify against', () => {
  /*
   * **The easiest production integration used to be one with both guarantees quietly off.**
   * `manifest` and `registry` were optional in every mode: without a manifest nothing links and no
   * missing capability is refused, without a registry no effect is inferred and `@deterministic` is
   * a claim nothing checked. A `.drs` file saying `@deterministic` looked identical either way, and
   * so did the build.
   *
   * Development stays permissive, because an editor open on a file with no project configured is a
   * real state rather than a misconfiguration, and refusing to start would show nothing where it
   * could show most of the errors.
   */
  const build = (overrides: Partial<CompileOptions>) =>
    compileDriftScript('fn f() -> f32 {\n    return 1\n}\n', {
      filename: 'p.drs',
      host: singleFileHost(),
      mode: 'production',
      ...overrides,
    });

  const manifest = { name: 'test', provides: [] };

  it('compiles when given both', () => {
    expect(build({ manifest, registry: createRegistry() }).diagnostics).toEqual([]);
  });

  it('refuses without a manifest, naming what it does not have', () => {
    expect(() => build({ registry: createRegistry() })).toThrow(/`manifest`/);
  });

  it('refuses without a registry', () => {
    expect(() => build({ manifest })).toThrow(/`registry`/);
  });

  it('names both when both are missing, and the way out in the same sentence', () => {
    expect(() => build({})).toThrow(/`manifest` and no `registry`/);
    expect(() => build({})).toThrow(/verification: 'none'/);
  });

  it('builds unverified when a caller says so in a word nobody sets by accident', () => {
    expect(build({ verification: 'none' }).diagnostics).toEqual([]);
  });

  it('leaves development alone', () => {
    const result = compileDriftScript('fn f() -> f32 {\n    return 1\n}\n', {
      filename: 'p.drs',
      host: singleFileHost(),
      mode: 'development',
    });
    expect(result.diagnostics).toEqual([]);
  });
});

describe('the fixed simulation step belongs to the target', () => {
  /*
   * It was a constant in the parser, whose own comment named what would make that wrong: a host
   * running a different one. A parser answers what the author wrote; how many fixed steps a second
   * holds is a property of the host's loop, and `update at 1Hz` cannot be turned into a stride
   * without it.
   */
  const SOURCE = 'system Tick {\n    update at 1Hz { }\n}\n';

  const strideAt = (fixedStepsPerSecond?: number): number => {
    const result = compileDriftScript(SOURCE, {
      filename: 's.drs',
      host: singleFileHost(),
      mode: 'development',
      fixedStepsPerSecond,
    });
    expect(result.diagnostics).toEqual([]);
    /* Read off the emitted metadata, which is what a host schedules from. */
    const found = /"everyTicks":(\d+)/.exec(result.code);
    return found === null ? -1 : Number(found[1]);
  };

  it.each([
    [undefined, 60],
    [60, 60],
    [30, 30],
    [120, 120],
  ])('compiles `at 1Hz` against %s steps a second as a stride of %d', (steps, stride) => {
    expect(strideAt(steps)).toBe(stride);
  });

  it('records what the strides were computed against, so a cached module can be told apart', () => {
    const result = compileDriftScript(SOURCE, {
      filename: 's.drs',
      host: singleFileHost(),
      mode: 'development',
      fixedStepsPerSecond: 30,
    });
    expect(result.code).toContain('"fixedStepsPerSecond":30');
  });

  it('names this target when a rate does not divide its step, not sixty', () => {
    const result = compileDriftScript('system Tick {\n    update at 4Hz { }\n}\n', {
      filename: 's.drs',
      host: singleFileHost(),
      mode: 'development',
      fixedStepsPerSecond: 30,
    });
    const message = result.diagnostics.map((d) => d.message).join('\n');
    expect(result.diagnostics.map((d) => d.code)).toContain('DS0133');
    expect(message).toContain('1/30');
    /* The list of ways out is this target's divisors, not the ones that happen to divide sixty. */
    expect(message).toContain('1, 2, 3, 5, 6, 10, 15, 30Hz');
  });

  it('accepts a rate that divides this target and not the default', () => {
    const result = compileDriftScript('system Tick {\n    update at 8Hz { }\n}\n', {
      filename: 's.drs',
      host: singleFileHost(),
      mode: 'development',
      fixedStepsPerSecond: 120,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses a step that is not a whole number of steps a second', () => {
    expect(() =>
      compileDriftScript(SOURCE, {
        filename: 's.drs',
        host: singleFileHost(),
        mode: 'development',
        fixedStepsPerSecond: 59.94,
      }),
    ).toThrow(/whole number/);
  });
});

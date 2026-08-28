import { describe, expect, it } from 'vitest';
import { FLOAT, type CapabilityDefinition, createRegistry, defineCapability } from './capability.ts';

const PLAY: CapabilityDefinition = defineCapability({
  module: 'drift/audio',
  name: 'play',
  signature: 'fn(sound: Sound, gain: f32) -> void',
  params: [{ name: 'sound', type: 'Sound' }, { name: 'gain', type: 'f32' }],
  returns: 'void',
  effects: ['audio.write'],
  deterministic: false,
  doc: 'Play a resolved sound slot through the mix.',
  implementation: 'AudioGraph.play',
});

describe('the capability registry', () => {
  it('stores a definition and returns it by module and name', () => {
    const registry = createRegistry();
    registry.add(PLAY);
    expect(registry.get('drift/audio', 'play')).toBe(PLAY);
  });

  it('answers undefined for a capability nobody registered', () => {
    expect(createRegistry().get('drift/audio', 'play')).toBeUndefined();
  });

  it('names an implementation rather than holding one', () => {
    expect(typeof PLAY.implementation).toBe('string');
    for (const value of Object.values(PLAY)) {
      expect(typeof value).not.toBe('function');
    }
  });

  it('lists the modules it knows, which is what a manifest is checked against', () => {
    const registry = createRegistry();
    registry.add(PLAY);
    registry.add({ ...PLAY, name: 'stop', implementation: 'AudioGraph.stop' });
    expect(registry.modules()).toEqual(['drift/audio']);
    expect(registry.forModule('drift/audio').map((d) => d.name)).toEqual(['play', 'stop']);
  });

  it('refuses a duplicate registration rather than overwriting silently', () => {
    const registry = createRegistry();
    registry.add(PLAY);
    expect(() => registry.add(PLAY)).toThrow(/drift\/audio\.play/);
  });

  it('refuses a definition claiming determinism while declaring a non-pure effect', () => {
    expect(() => defineCapability({ ...PLAY, deterministic: true })).toThrow(/audio\.write/);
  });

  it('refuses a deterministic claim over a wall clock, entropy or a host', () => {
    for (const effect of ['clock.read', 'host', 'ai', 'nondeterministic'] as const) {
      expect(() =>
        defineCapability({ ...PLAY, effects: [effect], deterministic: true }),
      ).toThrow(new RegExp(effect.replace('.', '\\.')));
    }
  });

  it('accepts a deterministic claim over reads inside the simulation boundary', () => {
    for (const effect of ['pure', 'scene.read', 'physics.read', 'ecs.read'] as const) {
      expect(() =>
        defineCapability({ ...PLAY, effects: [effect], deterministic: true }),
      ).not.toThrow();
    }
  });

  it('refuses a definition that declares no effects at all', () => {
    expect(() => defineCapability({ ...PLAY, effects: [] })).toThrow(/pure/);
  });

  it('refuses a definition naming no implementation', () => {
    expect(() => defineCapability({ ...PLAY, implementation: '' })).toThrow(/implementation/);
  });

  it('keeps every definition reachable in one list, which is what tooling reads', () => {
    const registry = createRegistry();
    registry.add(PLAY);
    registry.add({ ...PLAY, module: 'drift/scene', name: 'setPosition', effects: ['scene.write'] });
    expect(registry.all()).toHaveLength(2);
    expect(registry.modules()).toEqual(['drift/audio', 'drift/scene']);
  });
});

describe('the determinism boundary', () => {
  it('lets a deterministic capability write entity state, because that is the simulation', () => {
    /*
     * A movement system writing a position is the canonical deterministic operation. A rule that
     * refused it would refuse the thing `@deterministic` exists to describe.
     */
    expect(() =>
      defineCapability({
        module: 'drift/ecs',
        name: 'write',
        signature: 'fn(entity: f64, value: f64) -> void',
        params: [
          { name: 'entity', type: 'f64' },
          { name: 'value', type: 'f64' },
        ],
        returns: 'void',
        effects: ['ecs.write'],
        deterministic: true,
        doc: 'Set a field.',
        implementation: 'World.write',
      }),
    ).not.toThrow();
  });

  it('accepts a signature polymorphic in its float width', () => {
    expect(() =>
      defineCapability({
        module: 'drift/ecs',
        name: 'lengthOf',
        signature: 'fn(x: float, y: float) -> float',
        params: [
          { name: 'x', type: FLOAT },
          { name: 'y', type: FLOAT },
        ],
        returns: FLOAT,
        effects: ['pure'],
        deterministic: true,
        doc: 'The length of a vector.',
        implementation: 'World.lengthOf',
      }),
    ).not.toThrow();
  });

  it('refuses a `float` return that no parameter can fix', () => {
    /* Every call would fall to the `f32` default, so the variable would be a slower spelling of
       `f32` while the host believed it had written something polymorphic. Caught at registration,
       where a person is watching, rather than at a call site where nothing looks wrong. */
    expect(() =>
      defineCapability({
        module: 'drift/ecs',
        name: 'gravity',
        signature: 'fn() -> float',
        params: [],
        returns: FLOAT,
        effects: ['pure'],
        deterministic: true,
        doc: 'The gravitational constant.',
        implementation: 'World.gravity',
      }),
    ).toThrow(/nothing fixes the width/);
  });

  it('refuses a decorated `float`, because only the bare name has a rule', () => {
    expect(() =>
      defineCapability({
        module: 'drift/ecs',
        name: 'maybeRead',
        signature: 'fn(entity: f64) -> float?',
        params: [{ name: 'entity', type: 'f64' }],
        returns: 'float?',
        effects: ['ecs.read'],
        deterministic: true,
        doc: 'A field, if it is there.',
        implementation: 'World.maybeRead',
      }),
    ).toThrow(/used bare or not at all/);
  });

  it('refuses a host type named `float`, which would make every signature ambiguous', () => {
    expect(() =>
      createRegistry().addType({ module: 'drift/ecs', name: FLOAT, doc: 'A number.' }),
    ).toThrow(/either float width/);
  });

  it('still refuses a deterministic capability that moves a node, which is the view', () => {
    /* The control. `scene.write` stays outside because a `SceneNode` is what draws, and render
       code may not mutate simulation state. */
    expect(() =>
      defineCapability({
        module: 'drift/scene',
        name: 'setPosition',
        signature: 'fn(node: f64) -> void',
        params: [{ name: 'node', type: 'f64' }],
        returns: 'void',
        effects: ['scene.write'],
        deterministic: true,
        doc: 'Move a node.',
        implementation: 'SceneNode.setPosition',
      }),
    ).toThrow(/scene.write/);
  });
});

describe('a capability naming a list', () => {
  it('accepts `List<T>` as a parameter and as a return', () => {
    /*
     * **Written for a path.** A navigation capability answers a sequence of points, and until 1.7.0
     * a `TypeName` could carry no parameterised form at all — so a host had the choice of a
     * count-and-index pair of capabilities or nothing. `Entity?` already worked; `List<T>` did not.
     */
    expect(() =>
      defineCapability({
        module: 'drift/navigation',
        name: 'path',
        signature: 'fn(fromX: f32, fromZ: f32) -> List<f32>',
        params: [
          { name: 'fromX', type: 'f32' },
          { name: 'fromZ', type: 'f32' },
        ],
        returns: 'List<f32>',
        effects: ['navigation.read'],
        deterministic: true,
        doc: 'A polyline, as flat x/z pairs.',
        implementation: 'Nav.path',
      }),
    ).not.toThrow();
  });

  it('lets a behaviour capability say what it touches', () => {
    /* `drift/behavior` was the one specified surface with no effect name, so a host could not
       register a capability for it at all — `defineCapability` requires one. */
    expect(() =>
      defineCapability({
        module: 'drift/behavior',
        name: 'tick',
        signature: 'fn(agent: Entity) -> void',
        params: [{ name: 'agent', type: 'Entity' }],
        returns: 'void',
        effects: ['behavior.write'],
        deterministic: false,
        doc: 'Advance an agent by one decision.',
        implementation: 'Behaviour.tick',
      }),
    ).not.toThrow();
  });

  it('still refuses a behaviour write that claims to be deterministic', () => {
    /* The deferral, and it is a deferral rather than a blocker: a host ships the track with
       `deterministic: false`, and moving the effect inside is one line on the day somebody can
       answer for its replay behaviour. */
    expect(() =>
      defineCapability({
        module: 'drift/behavior',
        name: 'tick',
        signature: 'fn(agent: Entity) -> void',
        params: [{ name: 'agent', type: 'Entity' }],
        returns: 'void',
        effects: ['behavior.write'],
        deterministic: true,
        doc: 'Advance an agent by one decision.',
        implementation: 'Behaviour.tick',
      }),
    ).toThrow(/behavior.write/);
  });
});


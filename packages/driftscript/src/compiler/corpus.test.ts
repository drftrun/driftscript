import { describe, expect, it } from 'vitest';
import { compileDriftScript, formatDiagnostic, singleFileHost} from './index.ts';
import { createRegistry, defineCapability } from '../registry/capability.ts';
import { registerStd } from '../std/index.ts';
import { defineTarget } from '../registry/manifest.ts';

/**
 * The design corpus: files written to exercise the language, read rather than run.
 *
 * The corpus exists because mock capability providers were withdrawn. A mock is a second
 * implementation of a contract with no first implementation to check it against, so anything it
 * agrees with is itself — which means the surfaces whose providers have not shipped can only be
 * exercised by *writing them down and reading them back*.
 *
 * **This is the strongest single check that the language was designed for the whole surface a host
 * describes rather than the one that shipped this month.** Every unwired file must parse and
 * type-check and fail *only* at linking. A `DS01xx` or `DS02xx` from one of them means the language
 * has been trimmed to what exists, which is the thing the whole design refuses.
 *
 * Two of these are ports of real Lua scripts rather than invented examples, and that is deliberate:
 * a corpus of what a language designer imagines people write tests the imagination.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

/*
 * Spelled out rather than built from a variable, because the bundler matches this call in the
 * syntax tree. A pattern assembled at run time reaches nothing and the suite passes having read
 * no files.
 *
 * **The top level only, deliberately.** `docs/corpus/animals/` is the cross-module corpus: those
 * files import each other, so they need a host this test does not have, and they are wired, so what
 * is worth asserting about them is that they compile against a *host's real capabilities* — which
 * this package may not import. A host's own repository is where that check belongs.
 */
const sources = import.meta.glob('../../../../docs/corpus/*.drs', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const files = Object.entries(sources)
  .map(([path, source]) => [path.split('/').pop() as string, source] as const)
  .sort((a, b) => a[0].localeCompare(b[0]));

/** Files whose every capability has a provider in the first host today. */
const WIRED = new Set([
  'AudioReactive.drs',
  'CampfireTending.drs',
  'EcsCoroutines.drs',
  'GuardBehaviour.drs',
  'PhysicsGrapple.drs',
  'TimedToggle.drs',
]);

/**
 * A registry describing the wired surfaces, as the engine bindings will.
 *
 * **A fixture, and not the source of truth about any signature.** It exists because this package may
 * not import an engine package, so it can only describe what a host *would* provide. That is a second
 * description of a capability, and the corpus drifted from the first: two files called `audio.play`
 * with one argument against a real signature taking two, and one called a `drift/scene` capability
 * that does not exist. Every existing test passed, because none of them had the real registry to
 * check against. A host's own suite is where the wired files meet its real registry.
 *
 * Hand-written here because this package may never
 * import it. When it does, this is replaced by the real definitions and the corpus becomes a test
 * of *them* — which is the point at which these files stop being read and start being run.
 */
const registry = () => {
  const r = createRegistry();
  /* The standard library, because a real host registers it and a fixture that did not would let a
     corpus file importing `std/math` fail here for a reason no consumer would ever hit. It is also
     the half of the surface these files had never exercised: nothing in the corpus called `std/*`
     until `EcsCoroutines.drs` did, which is part of why nobody noticed that every maths signature
     was single precision and every ECS field was double. */
  registerStd(r);
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

  r.addType({ module: 'drift/audio', name: 'Sound', doc: 'A decoded sound, resolved from a slot.' });
  /* These four mirror DriftEngine's real definitions exactly. Where they last diverged, the
     corpus compiled here and would not have compiled against the engine. */
  define('drift/audio', 'sound', [{ name: 'slot', type: 'String' }], 'Sound?', ['pure'], true);
  define(
    'drift/audio',
    'play',
    [
      { name: 'sound', type: 'Sound' },
      { name: 'gain', type: 'f32' },
    ],
    'void',
    ['audio.write'],
    false,
  );
  define(
    'drift/audio',
    'distanceGain',
    [
      { name: 'distance', type: 'f32' },
      { name: 'radius', type: 'f32' },
    ],
    'f32',
    ['pure'],
    true,
  );
  define('drift/time', 'frameDelta', [], 'f32', ['clock.read'], false);

  /* The physics surface `PhysicsGrapple.drs` uses, mirroring DriftEngine's real definitions.
     The type is `PhysicsWorld` rather than `World` because `drift/ecs` already registers that name
     and the real registry refuses the collision. */
  r.addType({ module: 'drift/physics', name: 'PhysicsWorld', doc: 'A rigid body world.' });
  const world = { name: 'world', type: 'PhysicsWorld' };
  const body = { name: 'body', type: 'i32' };
  const f32 = (name: string) => ({ name, type: 'f32' });
  define('drift/physics', 'raycast', [
    world, f32('x'), f32('y'), f32('z'), f32('dx'), f32('dy'), f32('dz'),
    f32('maxDistance'), { name: 'mask', type: 'i32' },
  ], 'bool', ['physics.read'], true);
  define('drift/physics', 'hitBody', [world], 'i32', ['physics.read'], true);
  define('drift/physics', 'hitX', [world], 'f32', ['physics.read'], true);
  define('drift/physics', 'hitY', [world], 'f32', ['physics.read'], true);
  define('drift/physics', 'hitZ', [world], 'f32', ['physics.read'], true);
  define('drift/physics', 'hitNormalY', [world], 'f32', ['physics.read'], true);
  define('drift/physics', 'hitFraction', [world], 'f32', ['physics.read'], true);
  define('drift/physics', 'bodyMass', [world, body], 'f32', ['physics.read'], true);
  define('drift/physics', 'contactCount', [world], 'i32', ['physics.read'], true);
  define('drift/physics', 'contactKind', [world, { name: 'index', type: 'i32' }], 'i32', ['physics.read'], true);
  define('drift/physics', 'contactA', [world, { name: 'index', type: 'i32' }], 'i32', ['physics.read'], true);
  define('drift/physics', 'applyImpulse', [
    world, body, f32('px'), f32('py'), f32('pz'), f32('atX'), f32('atY'), f32('atZ'),
  ], 'void', ['physics.write'], false);
  define('drift/physics', 'setVelocity', [
    world, body, f32('vx'), f32('vy'), f32('vz'),
  ], 'void', ['physics.write'], false);
  define('drift/physics', 'wake', [world, body], 'void', ['physics.write'], false);
  /* `drift/chemistry`, mirroring DriftEngine's real definitions. That surface shipped on
     2026-08-26 and `CampfireTending.drs` moved into the wired set with it. Only the capabilities
     that file names — a fixture describes what the corpus reaches, and the real registry has forty
     more. A host's own suite is what stops the two descriptions diverging. */
  r.addType({ module: 'drift/chemistry', name: 'Chemistry', doc: 'A chemistry world.' });
  const chem = { name: 'chem', type: 'Chemistry' };
  const parcel = { name: 'parcel', type: 'i32' };
  const at = [f32('x'), f32('y'), f32('z')];
  define('drift/chemistry', 'alive', [chem, parcel], 'bool', ['chemistry.read'], true);
  define('drift/chemistry', 'burning', [chem, parcel], 'bool', ['chemistry.read'], true);
  define('drift/chemistry', 'moisture', [chem, parcel], 'f32', ['chemistry.read'], true);
  define('drift/chemistry', 'charFraction', [chem, parcel], 'f32', ['chemistry.read'], true);
  define('drift/chemistry', 'surfaceTemperature', [chem, parcel], 'f32', ['chemistry.read'], true);
  define('drift/chemistry', 'heatRelease', [chem, parcel], 'f32', ['chemistry.read'], true);
  define('drift/chemistry', 'ignitionProgress', [chem, parcel], 'f32', ['chemistry.read'], true);
  define('drift/chemistry', 'oxygenFraction', [chem, ...at], 'f32', ['chemistry.read'], true);
  define('drift/chemistry', 'visibility', [chem, ...at], 'f32', ['chemistry.read'], true);
  define('drift/chemistry', 'ignite', [chem, parcel], 'void', ['chemistry.write'], true);
  define('drift/chemistry', 'wet', [chem, parcel, f32('kilograms')], 'void', ['chemistry.write'], true);

  /* `drift/ecs`, mirroring DriftEngine's real definitions. The entity model shipped on 2026-08-26 and
     `EcsCoroutines.drs` stopped being one of the files that does not link — so it moved into the
     wired set and this fixture had to grow the module. A host's own suite is what
     stops the two descriptions diverging. */
  r.addType({ module: 'drift/ecs', name: 'World', doc: 'A world.' });
  define('drift/ecs', 'alive', [
    { name: 'world', type: 'World' },
    { name: 'entity', type: 'f64' },
  ], 'bool', ['ecs.read'], true);
  define('drift/ecs', 'destroy', [
    { name: 'world', type: 'World' },
    { name: 'entity', type: 'f64' },
  ], 'bool', ['ecs.write'], false);
  define('drift/ecs', 'read', [
    { name: 'world', type: 'World' },
    { name: 'entity', type: 'f64' },
    { name: 'component', type: 'String' },
    { name: 'field', type: 'String' },
  ], 'f64', ['ecs.read'], true);
  define('drift/ecs', 'write', [
    { name: 'world', type: 'World' },
    { name: 'entity', type: 'f64' },
    { name: 'component', type: 'String' },
    { name: 'field', type: 'String' },
    { name: 'value', type: 'f64' },
  ], 'void', ['ecs.write'], false);
  define('drift/ecs', 'count', [
    { name: 'world', type: 'World' },
    { name: 'component', type: 'String' },
  ], 'u32', ['ecs.read'], true);
  define('drift/ecs', 'at', [
    { name: 'world', type: 'World' },
    { name: 'component', type: 'String' },
    { name: 'index', type: 'u32' },
  ], 'f64', ['ecs.read'], true);
  define('drift/scene', 'position', [{ name: 'node', type: 'Node' }], 'f32', ['scene.read'], true);
  define(
    'drift/scene',
    'distance',
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

const FULL = defineTarget('full', [
  'drift/audio',
  'drift/chemistry',
  'drift/ecs',
  'drift/physics',
  'drift/time',
  'drift/scene',
]);
const BARE = defineTarget('web-min', []);

describe('the design corpus', () => {
  it('finds the files, so an empty directory is a failure rather than a pass', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files.map(([name]) => name)).toContain('NetworkReplicatedActor.drs');
  });

  it.each(files.filter(([name]) => WIRED.has(name)))(
    '%s compiles clean against a target that provides its capabilities',
    (name, source) => {
      const result = compileDriftScript(source, {
        filename: name,
        registry: registry(),
        manifest: FULL,
        host: singleFileHost(),
        mode: 'development',
      });
      if (result.diagnostics.length > 0) {
        throw new Error(
          `${name} does not compile:\n\n` +
            result.diagnostics.map((d) => formatDiagnostic(d, source)).join('\n\n'),
        );
      }
      expect(result.code).not.toBe('');
    },
  );

  /**
   * The invariant, asserted over every file rather than over one.
   *
   * A file using an unprovided surface parses and type-checks; only linking declines it. Compiled
   * with **no manifest**, an unwired file must produce no diagnostics at all — the surfaces it
   * names are not yet describable, so there is nothing for the checker to disagree with, and any
   * complaint would be about syntax or types the design says are fine.
   */
  it.each(files.filter(([name]) => !WIRED.has(name)))(
    '%s parses and type-checks even though nothing provides it',
    (name, source) => {
      const result = compileDriftScript(source, { filename: name, host: singleFileHost(), mode: 'development' });
      if (result.diagnostics.length > 0) {
        throw new Error(
          `${name} should parse and type-check:\n\n` +
            result.diagnostics.map((d) => formatDiagnostic(d, source)).join('\n\n'),
        );
      }
    },
  );

  it.each(files.filter(([name]) => !WIRED.has(name)))(
    '%s is refused only at linking, and the refusal names a track',
    (name, source) => {
      const result = compileDriftScript(source, {
        filename: name,
        manifest: BARE,
        host: singleFileHost(),
        mode: 'development',
      });

      expect(result.diagnostics.length).toBeGreaterThan(0);
      /* Only DS03xx. A DS01xx or DS02xx here means the language was trimmed to what shipped. */
      expect(result.diagnostics.every((d) => d.code.startsWith('DS03'))).toBe(true);
      expect(result.diagnostics.some((d) => /no host provides it yet/.test(d.message))).toBe(true);
    },
  );

  it('refuses a wired file too, when the target does not provide its modules', () => {
    const [, source] = files.find(([name]) => name === 'AudioReactive.drs') as [string, string];
    const result = compileDriftScript(source, {
      filename: 'AudioReactive.drs',
      manifest: BARE,
      host: singleFileHost(),
      mode: 'development',
    });
    expect(result.diagnostics.every((d) => d.code === 'DS0301')).toBe(true);
    expect(result.diagnostics.some((d) => d.message.includes('This host provides it'))).toBe(true);
  });
});

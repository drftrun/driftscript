/**
 * The Capability Registry: it **describes** a host capability and never becomes the call path.
 *
 * The source RFC wanted `invoke(args, context)` on the definition itself, making the registry the
 * central seam every call passes through. That is declined, for two reasons that are not about
 * taste.
 *
 * The first is performance and it is a hard rule rather than a preference: routing a per-frame draw
 * through a schema lookup allocates, and the engine's budget is zero allocations in a hot path.
 * The three registration mechanisms that already exist are each shaped by what they register —
 * generational handles on the frame path, an opt-in service seam whose methods may not throw, a
 * store the caller supplies — and collapsing them into one definition shape loses what makes each
 * correct.
 *
 * The second is why this package can leave the repository at all. **A description layer is
 * trivially host-neutral; a call path is not.** Had the registry wrapped implementations, the
 * language would own a way into the engine and would be inextractable — and nobody would have
 * noticed until the day somebody tried.
 *
 * So a definition names its implementation as a **string**. The host supplies the actual functions
 * as a map at link time, keyed by `module.name`. What survives from the RFC is the prize: one
 * declaration still derives compiler types, linker requirements, effect metadata, documentation,
 * completion and tool schemas. It just stops trying to be the call as well.
 */

/**
 * The effect set, tracked independently of whether a subsystem is available.
 *
 * An effect is a property of the code; availability is a property of the target. A function that
 * writes to audio has `audio.write` whether or not this target links audio, which is what lets a
 * `.drs` file be checked against capabilities that have not shipped.
 */
export type Effect =
  | 'pure'
  | 'clock.read'
  | 'scene.read'
  | 'scene.write'
  | 'ecs.read'
  | 'ecs.write'
  | 'physics.read'
  | 'physics.write'
  | 'chemistry.read'
  | 'chemistry.write'
  | 'navigation.read'
  | 'navigation.write'
  | 'animation.write'
  | 'audio.write'
  | 'input.read'
  | 'persistence.read'
  | 'persistence.write'
  | 'network.read'
  | 'network.write'
  | 'editor'
  | 'host'
  | 'ai'
  | 'nondeterministic';

/**
 * Effects a `@deterministic` function may still have.
 *
 * This grounds determinism on the boundary `AGENTS.md` already draws rather than defining a second
 * one: nothing on a path a consumer might simulate reads a wall clock, reads entropy, or reaches a
 * host. Reads of simulation state are inside the boundary; every write to something **outside** it,
 * and every clock that is not the fixed step, is not.
 *
 * **`ecs.write` is inside, added 2026-08-26 with the entity model.** Entity state *is* the
 * simulation — a movement system writing a position is the canonical deterministic operation, and a
 * rule that refused it would refuse the thing `@deterministic` exists to describe. `scene.write` is
 * outside for a reason that does not apply here: a `SceneNode` is what *draws*, and
 * `ARCHITECTURE.md` forbids render code mutating simulation state, so moving a node is a change to
 * the view.
 *
 * **`chemistry.write` is inside, added 2026-08-26 with the chemistry surface**, and the paragraph
 * below is what let it in. A parcel's composition and enthalpy are simulated quantities in exactly
 * the sense a component's fields are: they are integrated on the fixed step, they touch no clock,
 * and heating a log is the canonical operation of the package. A rule that refused it to a
 * `@deterministic` function would refuse the thing the annotation exists to describe.
 *
 * `physics.write`, `navigation.write` and `network.write` stay outside, and that is a deferral
 * rather than a judgement: each belongs to a track that has not shipped, and the track that builds
 * one is the one that can say whether its writes are the simulation or a consequence of it.
 *
 * `clock.read` is absent deliberately. The fixed step's delta is *supplied* to a simulation rather
 * than read by it, so a deterministic function receives time as a parameter — which is exactly how
 * `sampleClip` is a pure function of a caller-supplied time.
 */
export const DETERMINISTIC_EFFECTS: ReadonlySet<Effect> = new Set<Effect>([
  'pure',
  'scene.read',
  'ecs.read',
  'ecs.write',
  'physics.read',
  'chemistry.read',
  'chemistry.write',
  'navigation.read',
  'network.read',
  'persistence.read',
]);

/**
 * A parameter or return type, named as a script writes it.
 *
 * A *string* rather than the checker's own `Type`, and that is deliberate. The registry describes a
 * host to the language; making it speak the checker's internal representation would couple every
 * host binding to a type the compiler is free to change, and would put the compiler on the runtime
 * side of the `exports` split — a host registers its capabilities at run time, beside the code that
 * implements them.
 *
 * The checker resolves these the same way it resolves a written annotation: a primitive, a type the
 * module declares, or an opaque type a host registered. An unresolvable name is a diagnostic at the
 * registration rather than at every call site.
 */
export type TypeName = string;

export interface CapabilityParam {
  readonly name: string;
  readonly type: TypeName;
}

export interface CapabilityDefinition {
  /** The logical script module this belongs to, such as `drift/audio`. */
  readonly module: string;
  readonly name: string;
  /** The signature as a script author reads it, and as hover and completion show it. */
  readonly signature: string;
  /** The parameters, for checking a call. `signature` is for a person; this is for the compiler. */
  readonly params: readonly CapabilityParam[];
  /** The type a call yields. `void` for a capability called for its effect. */
  readonly returns: TypeName;
  readonly effects: readonly Effect[];
  readonly deterministic: boolean;
  /**
   * Whether calling this allocates on the host's side.
   *
   * The only way a `@hot` function can be told that a capability costs it an object — a typed-array
   * view, a decoded buffer, a fresh handle. `AGENTS.md` names views explicitly as allocations, and
   * the language has no array type, so the host is the only party that can answer.
   *
   * Absent means no, which is the right default: a lookup and a number are what most capabilities
   * are. **What would make that wrong** is a host that allocates without saying so, which is the
   * same silence a binding's `effects` already asks it to break.
   */
  readonly allocates?: boolean;
  readonly doc: string;
  /**
   * The symbol that implements this, as a **name**. Never a function.
   *
   * The host resolves it at link time. A definition holding a callable would put the registry on
   * the call path, which is the whole of R2 — and would give this package a reference to engine
   * code, which is the whole of R10.
   */
  readonly implementation: string;
}

/**
 * Validate a definition at the moment it is written.
 *
 * **This throws, where the compiler does not, and the difference is where it runs.** A definition
 * is evaluated at module load in a build process or a test — `AGENTS.md`'s fail-fast-at-init rule
 * applies and a bad one should stop everything. A compiler runs against a user's source, where
 * throwing means reporting one error and losing the rest.
 *
 * The determinism check is what makes the effect system trustworthy at its root. `@deterministic`
 * compiles to a refusal to call anything the registry marks otherwise, so a definition that lies
 * about itself makes the compiler's guarantee false everywhere at once, silently.
 */
export function defineCapability(definition: CapabilityDefinition): CapabilityDefinition {
  if (definition.effects.length === 0) {
    throw new Error(
      `${definition.module}.${definition.name} declares no effects; use ['pure'] to say so explicitly`,
    );
  }

  if (definition.deterministic) {
    const offending = definition.effects.filter((e) => !DETERMINISTIC_EFFECTS.has(e));
    if (offending.length > 0) {
      throw new Error(
        `${definition.module}.${definition.name} claims to be deterministic while declaring ` +
          `${offending.join(', ')}. A deterministic capability may not reach a wall clock, ` +
          'entropy, a host, or anything outside the simulation boundary.',
      );
    }
  }

  if (definition.implementation.length === 0) {
    throw new Error(`${definition.module}.${definition.name} names no implementation`);
  }

  return definition;
}

/**
 * A type a host provides and the language does not describe.
 *
 * `Sound`, `Node`, `Vec3` — values a script holds, passes back to the host, and cannot look inside.
 * The design calls these safe handles: a script receives one and never raw host internals, which is
 * what makes a capability boundary a boundary rather than a naming convention.
 *
 * They carry no fields on purpose. A field would be a promise about a host's representation, and
 * the moment a script can read one the host cannot change it.
 */
export interface OpaqueType {
  readonly module: string;
  readonly name: string;
  readonly doc: string;
}

export interface CapabilityRegistry {
  add(definition: CapabilityDefinition): void;
  addType(type: OpaqueType): void;
  get(module: string, name: string): CapabilityDefinition | undefined;
  getType(name: string): OpaqueType | undefined;
  /** Every module with at least one definition, in the order they were first registered. */
  modules(): readonly string[];
  forModule(module: string): readonly CapabilityDefinition[];
  all(): readonly CapabilityDefinition[];
  types(): readonly OpaqueType[];
}

export function createRegistry(): CapabilityRegistry {
  const byModule = new Map<string, CapabilityDefinition[]>();
  const byKey = new Map<string, CapabilityDefinition>();
  const opaque = new Map<string, OpaqueType>();

  return {
    addType(type) {
      const existing = opaque.get(type.name);
      if (existing !== undefined && existing.module !== type.module) {
        /* Opaque types share one namespace across modules, because a script writes `Sound` rather
           than `audio.Sound`. Two hosts claiming the name is a collision a script author cannot
           resolve, so it fails at registration where somebody can. */
        throw new Error(
          `\`${type.name}\` is registered by both \`${existing.module}\` and \`${type.module}\``,
        );
      }
      opaque.set(type.name, type);
    },
    getType(name) {
      return opaque.get(name);
    },
    types() {
      return [...opaque.values()];
    },
    add(definition) {
      const key = `${definition.module}.${definition.name}`;
      if (byKey.has(key)) {
        /*
         * A duplicate is refused rather than overwritten.
         *
         * Two packages registering the same capability is two answers to one question, and the one
         * that wins is whichever imported last — an ordering nobody controls and nothing reports.
         * Refusing makes the collision a startup failure at the line that caused it.
         */
        throw new Error(`${key} is already registered; a capability has one definition`);
      }
      byKey.set(key, definition);
      const existing = byModule.get(definition.module);
      if (existing === undefined) byModule.set(definition.module, [definition]);
      else existing.push(definition);
    },
    get(module, name) {
      return byKey.get(`${module}.${name}`);
    },
    modules() {
      return [...byModule.keys()];
    },
    forModule(module) {
      return byModule.get(module) ?? [];
    },
    all() {
      return [...byKey.values()];
    },
  };
}

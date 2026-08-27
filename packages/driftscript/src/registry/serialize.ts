/**
 * A registry, as data a process can read without importing the host that built it.
 *
 * **This is R2 taken at its word.** The registry describes and never invokes: a definition names
 * its implementation as a *string*, and every other field is a name, a signature or a flag. Nothing
 * in it is a function, so nothing in it needs the code that produced it — which means a registry
 * can cross a process boundary as JSON, and a language server can know what a host provides without
 * being able to call any of it.
 *
 * **That is not a convenience, it is the only way this works for most hosts.** A host written with
 * extensionless relative imports — the usual shape, because a bundler resolves them and nothing else
 * has to — *cannot be imported by a plain Node process at all*: it fails on the first `./registry`
 * with no extension. A language server is a plain Node process. It reads this instead.
 *
 * The cost is a generated file that goes stale, which is the same cost the generated grammar has
 * and is paid the same way: with a check that fails when it has. What would make it wrong is a
 * capability that cannot be described without a callable, which R2 already forbids.
 */
import {
  type CapabilityDefinition,
  type CapabilityRegistry,
  type OpaqueType,
  createRegistry,
  defineCapability,
} from './capability.ts';
import type { TargetManifest } from './manifest.ts';

export interface SerializedRegistry {
  /** Bumped when the shape below changes, so a stale file is refused rather than misread. */
  readonly version: 1;
  readonly capabilities: readonly CapabilityDefinition[];
  readonly types: readonly OpaqueType[];
}

export function serializeRegistry(registry: CapabilityRegistry): SerializedRegistry {
  return { version: 1, capabilities: registry.all(), types: registry.types() };
}

/**
 * Rebuild a registry from its data.
 *
 * **Every definition goes back through `defineCapability`**, which validates it. Trusting the file
 * would mean a hand-edited or half-written one produces a registry the compiler then reasons from,
 * and the first sign would be a wrong answer in an editor rather than a refusal at the boundary.
 * The cost is that reading is as strict as writing, which is the point.
 */
export function registryFromJson(data: SerializedRegistry): CapabilityRegistry {
  if (data.version !== 1) {
    throw new Error(`unsupported capability file version ${String(data.version)}; expected 1`);
  }
  const registry = createRegistry();
  for (const type of data.types) registry.addType(type);
  for (const capability of data.capabilities) registry.add(defineCapability(capability));
  return registry;
}


/**
 * A target that provides everything a capability file describes.
 *
 * **A manifest is a deliberate choice about what a build ships**, which is why the plugin does not
 * default to this: a build that linked every capability its host *could* provide would link ones it
 * never meant to. But a consumer who does want all of them should not have to write the list out,
 * and writing it out by hand is a second copy that goes stale the first time a host grows a surface.
 *
 * Takes the data rather than a registry, so a bundler config can build one without importing the
 * host — which is the whole reason this file exists.
 */
export function targetFromCapabilities(
  data: SerializedRegistry,
  name = 'driftengine',
): TargetManifest {
  const provides: string[] = [];
  for (const capability of data.capabilities) {
    if (!provides.includes(capability.module)) provides.push(capability.module);
  }
  return { name, provides };
}

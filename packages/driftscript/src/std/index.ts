/**
 * The standard library: what the language provides in every host.
 *
 * **A target may not decline any of it**, which is what "standard" means and what
 * `registry/manifest.ts` refuses a manifest for claiming. A script using only `std/*` runs against
 * a host that provides nothing at all — the property `examples/` asserts on every file.
 *
 * Everything here is `pure` and deterministic. That is not a coincidence: a library function that
 * observed anything would be observing a *host*, and would therefore belong to that host's prefix
 * rather than to this one.
 */
import type { CapabilityDefinition, CapabilityRegistry } from '../registry/capability.ts';
import { MATH_CAPABILITIES, MATH_MODULE, mathImplementation } from './math.ts';
import { TIME_CAPABILITIES, TIME_MODULE, timeImplementation } from './time.ts';

export { MATH_CAPABILITIES, MATH_MODULE, mathImplementation } from './math.ts';
export { TIME_CAPABILITIES, TIME_MODULE, timeImplementation } from './time.ts';
export { identity } from './core.ts';

export const STD_CAPABILITIES: readonly CapabilityDefinition[] = [
  ...MATH_CAPABILITIES,
  ...TIME_CAPABILITIES,
];

/**
 * Register the standard library into a host's registry.
 *
 * A host calls this alongside its own definitions. It is not automatic, because a registry that
 * populated itself would be a registry a test could not build empty — and the tests that check what
 * a *host* provides need exactly that.
 */
export function registerStd(registry: CapabilityRegistry): void {
  for (const capability of STD_CAPABILITIES) registry.add(capability);
}

/**
 * The implementations, keyed by module the way a generated module's `__bind` looks them up.
 *
 * Merged into a host's own map rather than bound separately, because a module importing both
 * `std/math` and `drift/audio` receives one host object. A host that forgot to merge these would
 * produce a script that fails on `math.clamp` with the namespace undefined — which is why
 * `engineImplementations` does the merge rather than leaving it to a consumer.
 */
export function stdImplementations(): Record<string, unknown> {
  return {
    [MATH_MODULE]: mathImplementation(),
    [TIME_MODULE]: timeImplementation(),
  };
}

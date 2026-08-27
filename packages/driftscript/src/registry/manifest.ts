/**
 * The Target Capability Manifest: what a particular target provides, and therefore what links.
 *
 * This is the other half of the mechanism that lets one language be specified for an engine that
 * does not exist yet. A `.drs` file declaring a component parses in every target and executes only
 * where an entity model is linked; a file annotating a field `@replicated` parses everywhere and
 * links only where a networking provider exists. The manifest is where a target says which.
 */

/**
 * The language's own modules, provided by every target because the language provides them.
 *
 * **A manifest may not list one, and that refusal is R9 defended rather than pedantry.** A target
 * that could *claim* `std/math` could also *decline* it, and a standard library that is optional
 * per host is not standard. Every host inherits these unchanged; what a host chooses is its own
 * prefix's modules.
 */
/*
 * **`std/collections` was here and never existed**, which is the advertisement a consumer reported.
 *
 * It was listed as a standard module and in the language reference, and no capability was ever
 * registered under it — so a script that imported it was told the module had no such capability,
 * by a compiler that had promised the module in two documents. Lists arrived in 1.6.0 as language
 * forms rather than as a module: `[a, b]`, `xs[i]`, `len`, `push` and `for … in` are built in,
 * because a capability's parameter types are *names* in a published data format and a module
 * function over `List<T>` would have needed a type variable there for a host to get wrong.
 *
 * So the entry is gone rather than filled in. What replaced it is in `LANGUAGE.md` under Types.
 */
export const STD_MODULES: readonly string[] = [
  'std/core',
  'std/math',
  'std/result',
  'std/time',
];

const STD_SET: ReadonlySet<string> = new Set(STD_MODULES);

/**
 * Prefixes a module name may carry.
 *
 * Two today: the language's own, and `drift/`, which is the first host's. A second host registers
 * its own, which is why this is a list rather than a hard-coded pair of comparisons.
 *
 * The cost is that a typo in a manifest fails at `defineTarget` rather than at link time, which is
 * earlier and less informative about which script wanted it. That trade is deliberate: a manifest
 * is written once by a host author, where a link error is read by every script author.
 */
export const KNOWN_PREFIXES: readonly string[] = ['std/', 'drift/'];

export interface TargetManifest {
  readonly name: string;
  /** The `drift/*` modules this target provides. `std/*` is never listed. */
  readonly provides: readonly string[];
}

export function defineTarget(name: string, provides: readonly string[]): TargetManifest {
  for (const module of provides) {
    if (STD_SET.has(module)) {
      throw new Error(
        `target \`${name}\` lists \`${module}\`, which the language provides in every target. ` +
          'A standard library a target can decline is not standard.',
      );
    }
    if (!KNOWN_PREFIXES.some((prefix) => module.startsWith(prefix))) {
      throw new Error(
        `target \`${name}\` lists \`${module}\`, which is under no known module prefix ` +
          `(${KNOWN_PREFIXES.join(', ')}).`,
      );
    }
  }

  /* Deduplicated so a manifest assembled from several fragments — a host's own list plus an
     optional package's — does not report a module twice to anything that reads it. */
  return { name, provides: [...new Set(provides)] };
}

/**
 * Whether a target provides a module.
 *
 * `std/*` answers true without consulting `provides`, which is what makes a target with an empty
 * list still a usable language rather than one that cannot even do arithmetic.
 */
export function providesModule(manifest: TargetManifest, module: string): boolean {
  if (STD_SET.has(module)) return true;
  return manifest.provides.includes(module);
}

/**
 * The `.drs` transform for a consumer's bundler, and the rule for what an edit invalidates.
 *
 * **Vite's types are declared here rather than depended on**, following the precedent
 * `demo/main.ts` sets for its four HMR type names: this project has no build tooling and no
 * reason to acquire a dependency on one for a handful of type names. The rule that governs it is
 * sharper for a plugin than for a demo — a *plugin* may depend on Vite, because it is a build-side
 * artefact only a toolchain loads, but the runtime that ships to a browser may not, and one
 * dependency in one manifest does not distinguish the two.
 *
 * **This module is a build-side entry point.** It is not reachable from `driftscript`'s runtime
 * barrel, and `scripts/size-gate.test.mjs` is what notices if that stops being true: the
 * runtime-only fixture would grow by the whole compiler.
 */
import {
  type CompileOptions,
  type CompileResult,
  type InterfaceLedger,
  compileDriftScript,
  createInterfaceLedger,

  singleFileHost,} from './compiler/index.ts';
import type { SourceMap } from './compiler/emit/sourceMap.ts';
import { formatDiagnostic } from './compiler/diagnostics.ts';
import type { CapabilityRegistry } from './registry/capability.ts';
import { type SerializedRegistry, registryFromJson } from './registry/serialize.ts';
import type { TargetManifest } from './registry/manifest.ts';
import type { ModuleHost } from './compiler/modules/host.ts';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The slice of a bundler plugin this needs, declared locally.
 *
 * Structural rather than nominal, so the object this returns satisfies Vite's `Plugin` without
 * either side importing the other. What would make this wrong is Vite changing the shape of
 * `transform` — which would be a breaking change for every plugin in its ecosystem, so the risk is
 * shared rather than taken alone.
 */
export interface TransformResult {
  readonly code: string;
  readonly map: SourceMap;
}

/**
 * The two fields of a bundler's module node this reads, and no more.
 *
 * Declaring the whole node would be declaring a class with a dozen members that move between
 * versions. These two do not: a module has an id and the modules that import it, in every bundler
 * that has a graph at all.
 */
export interface HotUpdateModule {
  readonly id: string | null;
  readonly importers: ReadonlySet<HotUpdateModule>;
}

export interface HotUpdateOptions {
  readonly file: string;
  readonly modules: readonly HotUpdateModule[];
  read(): string | Promise<string>;
}

/**
 * The one thing the plugin needs from a bundler's transform context.
 *
 * Declared locally like the rest of Vite's surface — R8 — and it is one method because that is all
 * this uses. See `driftScript` for why it is not optional.
 */
export interface TransformContext {
  addWatchFile(id: string): void;
}

export interface DriftScriptPlugin {
  readonly name: 'driftscript';
  readonly enforce: 'pre';
  transform(this: TransformContext, code: string, id: string): TransformResult | null;
  hotUpdate(options: HotUpdateOptions): Promise<readonly HotUpdateModule[] | undefined>;
}

export interface DriftScriptPluginOptions {
  /**
   * The target to link against.
   *
   * Omitted, nothing links and nothing is refused — which is right for a first look at the language
   * and wrong for a build that is about to ship. A consumer that wants the refusals of §48 passes
   * one.
   */
  readonly manifest?: TargetManifest;
  /**
   * The capabilities this host describes, which is what effect inference reads.
   *
   * **Omitted, no effects are inferred and no annotation is checked** — so `@deterministic` on a
   * function in that build is a claim nothing verified. That is the right default for a first look
   * at the language, where there is no host to describe, and it is the wrong state for a build that
   * ships: the annotation is the language's safety story and an unchecked one is decoration.
   *
   * **A consumer whose host cannot be imported by Node wants `capabilities` below instead**, and
   * this option's own documentation used to send everybody here. It said passing a registry was
   * "one import" — and for the first host it was not, because a bundler config is loaded by
   * **Node** and that host's packages use extensionless relative imports that only a bundler
   * resolves. The documented path to turning linking and effect checking on could not be taken by
   * anybody, and the failure was silent in the direction that matters.
   *
   * This option is the right one when the host *can* be imported — `driftscript` itself is, which
   * is why `registerStd` in a config works — or when a consumer is building a registry in the same
   * process: a test, or a bundler that runs its own config through a transform. Somebody holding a
   * registry should not be made to serialise it first.
   */
  readonly registry?: CapabilityRegistry;
  /**
   * The same capabilities, as the data a Node process can actually read.
   *
   * A path to a capability file, or its parsed contents. A host writes one with
   * `serializeRegistry` and ships it beside its code, the way a host generates any other artefact
   * a toolchain has to read, and this is the option a consumer's bundler config wants when that
   * host cannot itself be imported by Node:
   *
   * ```ts
   * import { driftScript } from 'driftscript/vite';
   * import { fileURLToPath } from 'node:url';
   *
   * export default {
   *   plugins: [
   *     driftScript({
   *       capabilities: fileURLToPath(import.meta.resolve('my-engine/capabilities.json')),
   *       manifest: { name: 'my-game', provides: ['drift/ecs', 'drift/audio'] },
   *     }),
   *   ],
   * };
   * ```
   *
   * A generated file goes stale, which is the cost, and a host pays it the way the generated
   * grammar here is paid for: with a check that fails when it has.
   *
   * **This is the same mechanism the language server uses and for the same reason.** A registry
   * describes and never invokes, so nothing in it is a function and all of it survives a process
   * boundary — which is what lets a plain Node process know what a host provides without being able
   * to import a line of it.
   *
   * Passing both this and `registry` is refused rather than resolved by precedence: two
   * descriptions of what a host provides, and a build silently using the one nobody meant.
   */
  readonly capabilities?: string | SerializedRegistry;
  readonly mode?: CompileOptions['mode'];
  /**
   * Whether a `mode: 'production'` build may run without a manifest and a registry.
   *
   * **A production build is refused without both unless this is `'none'`.** This plugin is the
   * easiest way to ship a DriftScript build, and both options above it were optional — so the
   * shortest working config was one with capability linking and effect verification quietly off,
   * producing a bundle in which `@deterministic` had been checked by nothing. Development is
   * unaffected.
   */
  readonly verification?: CompileOptions['verification'];
  /**
   * This target's fixed simulation step, as steps per second. Defaults to 60.
   *
   * `update at 1Hz` becomes a stride — a count of fixed steps — and this is what turns one into the
   * other. A host whose loop runs at a different rate has to say so, or every rate in every module
   * is compiled for somebody else's clock. The value it was built with rides in the module's
   * metadata.
   */
  readonly fixedStepsPerSecond?: CompileOptions['fixedStepsPerSecond'];
}

/**
 * Resolve and read `.drs` files from disk, relative to whoever imported them.
 *
 * **The plugin runs in the toolchain, so Node is available to it** — and nothing it *emits* assumes
 * Node, which is the line that matters. `AGENTS.md` draws it for the whole package: a plugin may
 * depend on the build environment because only a build loads it; the runtime that reaches a browser
 * may not.
 *
 * The extension is appended here rather than written in source, matching the language: `drift/audio`
 * carries none either, and a file that spells two kinds of import two ways is a file with a rule to
 * remember.
 */
function filesystemHost(): ModuleHost {
  return {
    resolve(specifier, from) {
      const resolved = `${path.resolve(path.dirname(from.split('?')[0]), specifier)}.drs`;
      return existsSync(resolved) ? resolved : null;
    },
    load(id) {
      /* `existsSync` said yes a moment ago, and a file can still be gone — a save in flight, a
         branch switch mid-build. Answering null is what turns that into DS0501 rather than an
         exception out of a compiler that promises not to throw. */
      try {
        return readFileSync(id, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Whether a module id is a `.drs` file, ignoring any query a bundler appended. */
function isDriftScript(id: string): boolean {
  return id.split('?')[0].endsWith('.drs');
}

/**
 * The registry this build reads, from whichever way it was given one.
 *
 * Resolved once when the plugin is made rather than per transform: reading and validating a
 * capability file on every `.drs` in a project would be the same work several hundred times, and a
 * file that changed mid-build would give two files in one build different answers about the host.
 */
function resolveRegistry(options: DriftScriptPluginOptions): CapabilityRegistry | undefined {
  if (options.registry !== undefined && options.capabilities !== undefined) {
    throw new Error(
      'driftScript() was given both `registry` and `capabilities`, which are two descriptions of ' +
        'what this host provides. Pass one: `capabilities` for a bundler config, which Node loads ' +
        'and which therefore cannot import an engine package, and `registry` where a live one is ' +
        'already in hand.',
    );
  }
  if (options.registry !== undefined) return options.registry;
  if (options.capabilities === undefined) return undefined;

  if (typeof options.capabilities !== 'string') return registryFromJson(options.capabilities);

  let text: string;
  try {
    text = readFileSync(options.capabilities, 'utf8');
  } catch {
    /* Named rather than thrown through, because the path came from a consumer's config and the
       thing they need to see is which path this was. */
    throw new Error(
      `driftScript() could not read the capability file at \`${options.capabilities}\`. A host ` +
        'writes one with `serializeRegistry` and usually ships it beside its code; resolve it with ' +
        "`fileURLToPath(import.meta.resolve('<your host>/capabilities.json'))`.",
    );
  }
  return registryFromJson(JSON.parse(text) as SerializedRegistry);
}

export function driftScript(options: DriftScriptPluginOptions = {}): DriftScriptPlugin {
  /*
   * What each module's interface was when it last compiled.
   *
   * The retention across a failed compile is the whole reason this is a ledger rather than a `Map`
   * here, and the reason it lives in the compiler rather than in this file is that the language
   * server needs exactly the same decision. Two implementations of one decision drift, and these
   * two would drift into the build and the editor disagreeing about whether an edit was breaking.
   */
  const interfaces: InterfaceLedger = createInterfaceLedger();

  /*
   * One compile per (id, source).
   *
   * `hotUpdate` runs before the browser asks for the module, so without this every save compiles
   * twice: once to decide what to invalidate and once to answer the request. Keyed on the source
   * rather than a timestamp because that is what actually decides the answer, and holding one entry
   * per module means an idle project holds one compile per `.drs` file rather than a history.
   */
  const compiled = new Map<string, { source: string; result: CompileResult }>();

  /*
   * Resolved once, here, rather than inside `compile`.
   *
   * A project has hundreds of `.drs` files, and reading and validating a capability file for each
   * of them is the same work several hundred times. Worse, a file that changed mid-build would give
   * two files in one build different answers about what the host provides — and a misconfigured
   * path would be reported at the first `.drs` a browser happened to ask for rather than when the
   * config was loaded.
   */
  const registry = resolveRegistry(options);

  const compile = (source: string, id: string): CompileResult => {
    const hit = compiled.get(id);
    if (hit !== undefined && hit.source === source) return hit.result;

    const result = compileDriftScript(source, {
      filename: id,
      manifest: options.manifest,
      registry,
      host: filesystemHost(),
      mode: options.mode ?? 'development',
      verification: options.verification,
      fixedStepsPerSecond: options.fixedStepsPerSecond,
    });

    compiled.set(id, { source, result });
    return result;
  };

  return {
    name: 'driftscript',
    /*
     * `pre`, so this runs before a bundler's own transforms.
     *
     * A `.drs` file is not JavaScript until this has run, and a transform that saw it first would
     * either fail to parse it or, worse, pass it through unchanged and let the failure surface as a
     * syntax error in generated output nobody wrote.
     */
    enforce: 'pre',

    transform(code, id) {
      if (!isDriftScript(id)) return null;

      const result = compile(code, id);

      /*
       * Every resolved file import is declared as a watched dependency, **including a type-only one**.
       *
       * A type emits no `import` — a record's runtime name is `createDog`, not `Dog` — so a module
       * graph has no edge to follow, and a subtype whose only use of its base is the base clause
       * would never rebuild when that base changed. It would go on inlining the old defaults, which
       * is a stale value rather than an error and is invisible in the picture.
       *
       * Declared before the error check on purpose: a file that fails to compile still depends on
       * what it imported, and a build that stopped watching on failure would never notice the edit
       * that fixed it.
       */
      for (const dependency of result.metadata.imports) this.addWatchFile(dependency);

      /*
       * **Errors stop the build; warnings do not.**
       *
       * This guard was `result.diagnostics.length > 0`, which was right while every diagnostic was
       * an error and wrong from the day the checker learned its first warning: an unused import
       * would have failed a production build with `DriftScript failed to compile`. `compileDriftScript`
       * was corrected for exactly this and this line was not, so the same defect survived one layer
       * up — unreachable only because this plugin had no way to be given a registry, and reachable
       * the moment it did.
       */
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      if (errors.length > 0) {
        /*
         * A compile failure throws *here*, where the compiler itself does not.
         *
         * The compiler returns diagnostics because a language server needs every one of them and
         * cannot receive an exception. A bundler is the opposite: it has one slot for a failure and
         * a plugin that returned empty code would emit a module exporting nothing, so the error
         * would surface as a missing import three files away.
         *
         * Every error is in the message rather than only the first, since a build that reports one
         * error per run is a build a user fixes one error per run.
         */
        throw new Error(
          `DriftScript failed to compile ${id}\n\n` +
            errors.map((d) => formatDiagnostic(d, code)).join('\n\n'),
        );
      }

      interfaces.record(id, result.metadata.interfaceHash);
      return { code: result.code, map: result.map };
    },

    /**
     * What an edit invalidates, decided on the interface hash.
     *
     * **A body edit updates the module alone.** Its importers accepted it, so the runtime patches
     * the functions and the state they operate on stays alive, which is what a `.drs` file is for.
     *
     * **An interface change takes the `.drs` importers with it, and only those.** A subtype inlines
     * its base's defaults into its own constructor, so a base whose interface moved leaves every
     * `.drs` that extends it emitting the old literal — that file has to be recompiled and
     * re-executed, and rebuilding its state is unavoidable.
     *
     * **An application importer is deliberately left alone**, and this is a correction. It used to
     * be invalidated too, on the reasoning that `patchModule` refused a shape change and hot-patching
     * would leave a page running the previous version behind a message. Phase 5 made that false:
     * a shape change is migrated now. Invalidating the importer re-executes it, which rebuilds the
     * state from its constructor — destroying exactly what the migration exists to carry across.
     * Measured on a live server: adding a field to a record showed the field arriving and the page
     * silently restarting, with `reloads` still reading zero because the accept handler never ran.
     *
     * The cost is that an application whose *own* code depends on a `.drs` signature — one that
     * imported a binding directly rather than reaching through `exports` — is not re-executed by
     * this. Vite's own module graph handles that edge, because a direct import is an edge it can
     * see. What would make this wrong is an application that caches something derived from the
     * interface without importing it, which is a thing no bundler can see for anybody.
     *
     * A file that does not compile is **not** an interface change. Mid-save a file is unparseable
     * constantly, and resetting a page on each of those is the failure hot reload exists to prevent.
     * The ledger keeps the last good interface, and `transform` is what reports the error when the
     * browser asks for the module.
     */
    async hotUpdate(update) {
      if (!isDriftScript(update.file)) return undefined;

      /*
       * Every memoised compile is dropped, not just this file's.
       *
       * The memo is keyed on a module's own source, and a module's output depends on more than that:
       * a subtype inlines its base's defaults, so editing the base changes what the subtype emits
       * while leaving the subtype's source untouched. Keeping the entry would serve the stale result
       * the moment the bundler asked again — which is exactly what happened, on a live server, with
       * `addWatchFile` working perfectly: Vite re-ran the transform and the cache handed back the
       * previous answer. The feature looked broken while the mechanism was fine.
       *
       * Clearing costs one recompile per open module per save, and the memo only ever existed to
       * stop this hook and the transform below compiling the same file twice for one change.
       */
      compiled.clear();

      const source = await update.read();
      const result = compile(source, update.file);
      /*
       * The comparison here reads the ledger and does not write to it.
       *
       * **A bundler calls this once per environment**, twice on a default setup, and recording here
       * means the first call consumes the move and every later one sees an interface that did not
       * change. Found by instrumenting the hook against a live server rather than by reasoning: the
       * second call arrives with an empty module list, which made the defect harmless here and would
       * not on a setup where two environments both hold the module — one would invalidate its
       * importers and the other would not.
       *
       * `transform` is the one place that records, because it is the one place that runs once per
       * module per version. The cost is that a module invalidated but never re-requested — the page
       * was closed — keeps its old interface in the ledger, so the next edit compares against that
       * one and invalidates again. Conservative, and in the direction that rebuilds.
       */
      const previous = interfaces.lastGood(update.file);
      const hash = result.metadata.interfaceHash;
      /* An empty hash is a compile that failed, and a file that does not compile has not changed
         its interface — it has none. An unseen module has nothing live to invalidate. */
      const moved = hash !== '' && previous !== undefined && hash !== previous;
      if (!moved) return update.modules;

      /* Deduplicated, because two changed modules for one file — a bundler records one node per
         query variant — commonly share importers, and invalidating one twice is a second reload. */
      const affected: HotUpdateModule[] = [...update.modules];
      for (const module of update.modules) {
        for (const importer of module.importers) {
          /* A `.drs` importer only. An application importer accepted this module and its handler
             migrates; re-executing it would throw away the state that migration carries. */
          if (importer.id === null || !isDriftScript(importer.id)) continue;
          if (!affected.includes(importer)) affected.push(importer);
        }
      }
      return affected;
    },
  };
}

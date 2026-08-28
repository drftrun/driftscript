/**
 * Linking: what a target provides decides what a program may use, and a refusal has words in it.
 *
 * This is the whole thesis of the design reduced to something that either works or does not. A
 * module requires a capability the target does not provide; the linker refuses it, naming what and
 * why; the manifest is changed; **the same source links, unchanged**.
 *
 * That is what allows the language to be designed once, against the whole surface a host could
 * eventually provide, rather than trimmed to whatever shipped this month and redesigned every time
 * a subsystem lands.
 *
 * A file using an unprovided surface still **parses** and still **type-checks**. Only linking
 * declines it. If a type error ever appears for one of these, the language has been trimmed to
 * what shipped — which is the thing the design exists to refuse.
 */
import type { Span } from '../compiler/ast.ts';
import type { Diagnostic } from '../compiler/diagnostics.ts';
import { type TargetManifest, providesModule } from './manifest.ts';
import type { CapabilityRegistry } from './capability.ts';

/**
 * Every `drift/*` surface this language specifies, shipped or not.
 *
 * **A catalogue rather than a to-do list, and that distinction is the whole of the change.** What
 * stood here was a set of *unshipped* module names — one host's roadmap, inside a package that may
 * not know a host exists, which had to **shrink** every time that host shipped a track. So a host
 * could not bind a module until the language cut a release removing the name, and the host's own
 * suite asserted the two lists agreed in both directions. A foreign roadmap, kept in step by hand.
 *
 * This list never shrinks. It answers a different question — *is this a surface the language
 * designed?* — which is language knowledge and always was: `LANGUAGE.md` prints these, `parser.ts`
 * knows `drift/` is a prefix, and the design was made against the whole surface a host could
 * eventually provide rather than against whatever shipped this month.
 *
 * **Whether anything implements one is the registry's answer**, and the two together give a script
 * author the three sentences they can act on: this host has it and your manifest did not ask; this
 * is a real surface and nothing here implements it yet, so your file is fine; and this is not a
 * module at all, which is a typo.
 *
 * A surface is added here when it is designed, never removed when it is built.
 */
const SPECIFIED: ReadonlySet<string> = new Set([
  'drift/ai',
  'drift/animation',
  'drift/audio',
  'drift/behavior',
  'drift/camera',
  'drift/chemistry',
  'drift/core',
  'drift/ecs',
  'drift/editor',
  'drift/events',
  'drift/input',
  'drift/navigation',
  'drift/network',
  'drift/persistence',
  'drift/physics',
  'drift/prefab',
  'drift/random',
  'drift/render',
  'drift/rollback',
  'drift/scene',
  'drift/terrain',
  'drift/time',
  'drift/ui',
  'drift/xr',
  'drift/2d',
]);

/**
 * The surfaces the language specifies, for a host that wants to check its own names against them.
 *
 * The engine's suite used the list this replaced to assert it had not bound something the language
 * still called unshipped — a check that went red every time a track landed. Read this way round it
 * says something that stays true: a module a host binds should be one the language designed, and a
 * name outside this set is a host inventing a surface nobody specified.
 */
export const SPECIFIED_MODULES: readonly string[] = [...SPECIFIED];

/**
 * The specified module a misspelling was probably reaching for, as a sentence or nothing.
 *
 * A wrong module name is almost always a typo — `drift/nagivation` for `drift/navigation` — and
 * naming the near one is the difference between a diagnostic somebody acts on and one they read
 * twice. The same call `modules/interface.ts` makes for a wrong import name, and the same edit
 * distance: close enough to be a slip, far enough not to guess.
 */
function nearest(module: string): string {
  let best: string | null = null;
  let bestDistance = 4;
  for (const candidate of SPECIFIED) {
    const distance = editDistance(module, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best === null ? '' : ` Did you mean \`${best}\`?`;
}

/** Levenshtein, over two short module names. */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) rows.push([i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      (rows[i] as number[])[j] = Math.min(
        (rows[i - 1] as number[])[j] + 1,
        (rows[i] as number[])[j - 1] + 1,
        (rows[i - 1] as number[])[j - 1] + cost,
      );
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

export type LinkResult =
  | { readonly linked: true }
  | { readonly linked: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Check a module's requirements against a target.
 *
 * `spans` maps a module name to where it was imported, so the caret lands on the import rather
 * than at the top of the file. A requirement with no recorded span reports at offset zero, which
 * is honest about knowing the file and not the line.
 */
export function linkCapabilities(
  requires: readonly string[],
  manifest: TargetManifest,
  spans: ReadonlyMap<string, Span>,
  file: string,
  /**
   * For a requirement this file did not import directly, the file specifier that pulled it in.
   *
   * **The same code, `DS0301`, with more of the story.** A new code for a transitive refusal would
   * split a consumer's grep in half for a failure that is identical: a module this target does not
   * provide. What changes is only whether the reader can see the import from where the caret lands
   * — and without the clause they read "`drift/audio` is not provided" against a file that never
   * mentions audio, and go looking for an import that is not there.
   */
  through: ReadonlyMap<string, string> = new Map(),
  /**
   * What this host describes, which is what tells the two refusals apart.
   *
   * **This replaced a hardcoded list of module names, and the list was a standing violation of the
   * first line of `AGENTS.md`.** A module absent from *this* manifest and a module absent from
   * *every* host are different situations, and a diagnostic that reads the same for both teaches a
   * consumer that the language is broken when it is not — that part was right. The way it told them
   * apart was not: a `Set` of `drift/*` names, inside a package that may not know a host exists,
   * naming one host's unshipped tracks. Every time that host shipped one, the language needed a
   * release before the host could bind it, and the *engine's* own test asserted the two lists
   * agreed — a foreign roadmap kept in step by hand, in both directions.
   *
   * The registry answers the same question from data the host supplies. A module it has a
   * capability for is one this host describes and the manifest merely did not ask for; a module it
   * has nothing for is one nothing here implements. **Absent, the linker claims neither**, which is
   * the honest answer for the language-server path where no host was configured — and is what the
   * old code could not say, because it asserted "this host provides it" from the absence of a name
   * in a list it had made up.
   */
  registry?: CapabilityRegistry,
): LinkResult {
  const diagnostics: Diagnostic[] = [];

  for (const module of requires) {
    if (providesModule(manifest, module)) continue;

    const span = spans.get(module) ?? { start: 0, end: 0 };

    /* Appended rather than woven in, so the two refusals keep saying the different things they say:
       one is a manifest that did not ask, the other a surface nothing implements yet. */
    const pulledInBy = through.get(module);
    const via = pulledInBy === undefined ? '' : ` Required through \`${pulledInBy}\`.`;

    /*
     * Three sentences, and which one a reader gets is decided by two independent facts: whether the
     * language specifies the surface, and whether this host describes it. A registry is optional,
     * so "described" can be unknown — and where it is, the catalogue still separates a real surface
     * from a misspelling, which is the half that helps most and the half a registry cannot give.
     */
    const specified = SPECIFIED.has(module);
    const described = registry === undefined ? null : registry.modules().includes(module);
    const head = `\`${module}\` is not provided by target \`${manifest.name}\``;

    const message =
      (described === true
        ? `${head}. This host describes it. Add it to the target manifest to link it.`
        : specified && described === false
          ? `${head}, and nothing this host describes implements it. The module is specified and ` +
            'your file is valid; it links when a host implements it.'
          : specified
            ? /* No registry, so neither half is knowable — say both, and name the manifest, which
                 is the one thing a reader can act on without knowing which case they are in. */
              `${head}. The module is specified and your file is valid: add it to the target ` +
              'manifest if this host provides it, or it links when a host implements it.'
            : `${head}, and it is not a module this language specifies.` +
              `${nearest(module)} Check the spelling.`) + via;

    diagnostics.push({ code: 'DS0301', severity: 'error', message, file, ...span });
  }

  /* Every unprovided module is reported, not the first. A consumer adding capabilities to a
     manifest one refusal at a time is a consumer editing a manifest as many times as their file
     has imports. */
  return diagnostics.length === 0 ? { linked: true } : { linked: false, diagnostics };
}

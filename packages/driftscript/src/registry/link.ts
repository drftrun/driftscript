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

/**
 * Modules that are specified, parse, type-check, and have **no provider in any target yet**.
 *
 * A module absent from *this* manifest and a module absent from *every* manifest are different
 * situations, and a diagnostic that reads the same for both teaches a consumer that the language is
 * broken when it is not. That is the failure the design accepted a real cost to avoid: mock
 * capability providers were withdrawn precisely so an unwired surface stays visibly unwired, and a
 * refusal that cannot tell the two apart gives that cost away for nothing.
 *
 * **A set rather than a table of reasons, and that is a correction.** Each entry used to carry a
 * sentence naming the internal roadmap slot the module was waiting on, and those sentences reached a
 * script author inside a diagnostic — where a letter out of somebody else's planning document is
 * both meaningless and none of their business. What a reader can act on is that the module is
 * specified, that nothing provides it yet, and that their own file is fine. The rest was ours.
 *
 * **This list must shrink when a host ships one of them.** A test asserts it agrees with the module
 * table, because two lists of what is missing, maintained separately, is how a project ends up
 * advertising a hole it filled.
 */
const UNSHIPPED: ReadonlySet<string> = new Set([
  'drift/navigation',
  'drift/behavior',
  'drift/network',
  'drift/rollback',
  'drift/editor',
  'drift/terrain',
  'drift/ui',
  'drift/2d',
  'drift/xr',
  'drift/render',
]);

/** The modules with no provider anywhere yet, for the test that keeps this honest. */
export const UNSHIPPED_MODULES: readonly string[] = [...UNSHIPPED];

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
): LinkResult {
  const diagnostics: Diagnostic[] = [];

  for (const module of requires) {
    if (providesModule(manifest, module)) continue;

    const span = spans.get(module) ?? { start: 0, end: 0 };

    /* Appended rather than woven in, so the two refusals keep saying the different things they say:
       one is a manifest that did not ask, the other a surface nothing implements yet. */
    const pulledInBy = through.get(module);
    const via = pulledInBy === undefined ? '' : ` Required through \`${pulledInBy}\`.`;

    const message =
      (UNSHIPPED.has(module)
        ? `\`${module}\` is not provided by target \`${manifest.name}\`, and no host provides it ` +
          'yet. The module is specified and your file is valid; it links when a host implements it.'
        : `\`${module}\` is not provided by target \`${manifest.name}\`. ` +
          'This host provides it. Add it to the target manifest to link it.') +
      via;

    diagnostics.push({ code: 'DS0301', severity: 'error', message, file, ...span });
  }

  /* Every unprovided module is reported, not the first. A consumer adding capabilities to a
     manifest one refusal at a time is a consumer editing a manifest as many times as their file
     has imports. */
  return diagnostics.length === 0 ? { linked: true } : { linked: false, diagnostics };
}

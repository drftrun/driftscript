/**
 * The language service: everything an editor asks, answered by calling the compiler.
 *
 * **It re-implements no part of the front end**, and that is the load-bearing decision rather than
 * an efficiency. A server with its own parser disagrees with the build eventually — a keyword the
 * lexer learned and the server did not, a rule the checker tightened — and the day it does, people
 * learn to distrust the squiggles. They are right to: a squiggle that is sometimes wrong is worse
 * than none, because it costs attention every time.
 *
 * So `diagnostics()` is `compileDriftScript().diagnostics`, exactly, and a test asserts the two are
 * deep-equal over every corpus file. There is no class of error only the editor finds, and none it
 * misses.
 *
 * **What the server does own** is position mapping, the document store, caching, and the two
 * features that present compiler facts rather than computing them: capability-true completion and
 * semantic tokens carrying effects.
 */
import {
  type CompileResult,
  type Diagnostic,
  checkEffects,
  compileDriftScript,
  format,

  singleFileHost,} from 'driftscript/compiler';
import type { CapabilityRegistry, Effect, TargetManifest } from 'driftscript';
import { parse } from 'driftscript/compiler';
import { type Document, type DocumentStore, type Range, createDocumentStore } from './documents.ts';
import { type Analysis, analyse } from './analysis.ts';
import {
  type CompletionItem,
  type Hover,
  type Location,
  type SemanticToken,
  type SignatureHelp,
  completions,
  definition,
  documentSymbols,
  hover,
  semanticTokens,
  signatureHelp,
} from './features.ts';
import type { Declaration } from './analysis.ts';
import {
  type CodeAction,
  type RenameResult,
  codeActions,
  references,
  rename,
} from './edits.ts';
import { type Schedule, type Scheduler, createScheduler } from './schedule.ts';

export interface ServiceOptions {
  /** What the host describes. Completion and hover read it; without one they offer nothing. */
  readonly registry?: CapabilityRegistry;
  /** What the target provides. Completion greys what this does not link. */
  readonly manifest?: TargetManifest;
  /**
   * Who depends on a module, for incremental scheduling.
   *
   * **Supplied rather than derived, and empty by default.** A DriftScript module imports capability
   * modules and never another `.drs` file, so a workspace of open documents genuinely has no edges
   * and the default schedules exactly the file that changed. The graph that is real today belongs to
   * the *bundler* — a `.ts` importing a `.drs` — and a client that has one passes it here. The cost
   * of the default is nothing today and would be a missed rebuild the day the language grows file
   * imports, which is why `schedule` reads this on every call rather than caching it.
   */
  readonly dependentsOf?: (module: string) => readonly string[];
  /**
   * Read a module this service has no open document for.
   *
   * **Supplied rather than reached for, because this package has no filesystem.** It runs inside an
   * editor's process and its own tsconfig sets `types: []`; the server that starts it is Node and
   * passes one. Without it, only open documents resolve — which is right for a test and wrong for a
   * workspace where somebody imports a file they have not opened.
   *
   * Returning null is not an error to raise here: it becomes `DS0501` at the import, which says both
   * possibilities in words rather than guessing which one it is.
   */
  readonly readFile?: (path: string) => string | null;
}

export interface PublishedDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly range: Range;
}

export interface Service {
  open(uri: string, text: string): void;
  change(uri: string, text: string): void;
  close(uri: string): void;
  document(uri: string): Document | undefined;
  /** Exactly what a build would report, in editor coordinates. */
  diagnostics(uri: string): readonly PublishedDiagnostic[];
  /** The raw compiler diagnostics, for the agreement test and for anything comparing to a build. */
  rawDiagnostics(uri: string): readonly Diagnostic[];
  compile(uri: string): CompileResult | undefined;
  /** What to recompile after `uri` changed. Dependents only when its interface moved. */
  schedule(uri: string): Schedule;
  effectsOf(uri: string, fn: string): readonly Effect[];
  formatting(uri: string): string | undefined;

  hover(uri: string, offset: number): Hover | null;
  definition(uri: string, offset: number): Location | null;
  signatureHelp(uri: string, offset: number): SignatureHelp | null;
  completions(uri: string, offset: number): readonly CompletionItem[];
  semanticTokens(uri: string): readonly SemanticToken[];
  documentSymbols(uri: string): readonly Declaration[];
  references(uri: string, offset: number): readonly { start: number; end: number }[];
  rename(uri: string, offset: number, newName: string): RenameResult;
  codeActions(uri: string): readonly CodeAction[];
}

/**
 * Resolve a relative specifier against the file that wrote it.
 *
 * String arithmetic over the uri rather than a path library, because this package has neither one
 * nor a filesystem — and because a uri is what an editor speaks. `./x` and `../x` are the only two
 * forms the language admits, which is what makes this short enough to be obviously right.
 */
function resolveAgainst(specifier: string, from: string): string {
  const parts = from.slice(0, from.lastIndexOf('/')).split('/');
  for (const segment of specifier.split('/')) {
    if (segment === '.') continue;
    else if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return `${parts.join('/')}.drs`;
}

export function createService(options: ServiceOptions = {}): Service {
  const documents: DocumentStore = createDocumentStore();

  /*
   * Open documents first, then whatever the host can read.
   *
   * That order is the whole reason the compiler takes a host rather than reading files itself. An
   * editor showing errors computed from the saved version of a file somebody is in the middle of
   * changing is an editor showing yesterday's errors — and the failure is quiet, because the errors
   * it shows are real errors, just not the ones in front of you.
   */
  const host = {
    resolve: (specifier: string, from: string) => resolveAgainst(specifier, from),
    load: (id: string) => documents.get(id)?.text ?? options.readFile?.(id) ?? null,
  };

  /*
   * Who imports whom, derived from what was compiled rather than from a list somebody maintains.
   *
   * `metadata.imports` is the compiler's own answer, so a file that starts importing another is a
   * dependent from its next compile with no registration step to forget. The cost is that a document
   * nobody has asked about yet contributes no edges — which is correct rather than a gap: the
   * scheduler decides what to *re*compile, and nothing has compiled it.
   */
  const dependentsOf = (module: string): readonly string[] => {
    const declared = options.dependentsOf?.(module) ?? [];
    const found = [...declared];
    for (const document of documents.all()) {
      if (document.uri === module) continue;
      if ((importsOf.get(document.uri) ?? []).includes(module) && !found.includes(document.uri)) {
        found.push(document.uri);
      }
    }
    return found;
  };

  /*
   * One compile per document version.
   *
   * An editor asks for diagnostics, then hover, then semantic tokens, all against the same text.
   * Compiling per query is the obvious first write and makes a keystroke cost three compiles. The
   * key is the version rather than the text, so an edit that produces identical text — an undo back
   * to where you were — still invalidates, which is correct because nothing else depends on it and
   * comparing whole documents is what the version number exists to avoid.
   */
  const cache = new Map<string, { version: number; result: CompileResult }>();

  /*
   * What each document last compiled against, kept **outside** the compile cache.
   *
   * The first version of this read the edges out of the cache, which is circular: invalidating a
   * dependent removes the record of why it was a dependent, so the second edit to a base found no
   * dependents at all. The graph is knowledge about a file, not a cached answer about it, and it
   * survives until the document closes.
   */
  const importsOf = new Map<string, readonly string[]>();

  const compile = (uri: string): CompileResult | undefined => {
    const document = documents.get(uri);
    if (document === undefined) return undefined;

    const hit = cache.get(uri);
    if (hit !== undefined && hit.version === document.version) return hit.result;

    const result = compileDriftScript(document.text, {
      filename: uri,
      registry: options.registry,
      manifest: options.manifest,
      /*
       * Always `development`.
       *
       * An editor is a development surface by definition, and compiling as production here would
       * mean the squiggles a person sees are not the ones their dev build produces — the same
       * disagreement this whole file exists to prevent, one level down.
       */
      host,
      mode: 'development',
    });

    cache.set(uri, { version: document.version, result });
    importsOf.set(uri, result.metadata.imports);
    return result;
  };

  /*
   * The analysis is cached beside the compile, on the same version key.
   *
   * Hover, completion, semantic tokens and symbols all want the same token stream and the same
   * tree, and an editor asks for several of them per keystroke. Re-parsing per feature is the
   * obvious first write and makes a cursor move cost four parses.
   */
  const analyses = new Map<string, { version: number; analysis: Analysis }>();

  const analysisOf = (uri: string): Analysis | undefined => {
    const document = documents.get(uri);
    if (document === undefined) return undefined;
    const hit = analyses.get(uri);
    if (hit !== undefined && hit.version === document.version) return hit.analysis;
    const analysis = analyse(document.text, uri);
    analyses.set(uri, { version: document.version, analysis });
    return analysis;
  };

  /*
   * The scheduler reads this service's own compile cache for an interface, so the hash it compares
   * is exactly the one the build would produce — the same reason `diagnostics()` is the compiler's
   * diagnostics unmodified. A scheduler with its own notion of an interface would eventually
   * disagree with the build about whether an edit was breaking.
   */
  const scheduler: Scheduler = createScheduler({
    interfaceOf: (module) => compile(module)?.metadata.interfaceHash,
    dependentsOf,
  });

  /**
   * Drop every cached compile that was built against `uri`, and every one built against those.
   *
   * **The cache keys on a document's own version, and a module's output depends on more than that.**
   * A subtype inlines its base's defaults and a call is checked against an imported signature, so
   * editing the imported file changes what the importing file compiles to while leaving its version
   * untouched. Without this the service answers from the cache and reports yesterday's diagnostics
   * about today's code.
   *
   * The same defect existed in the Vite plugin's own memo and was found on a live server rather than
   * here — two caches, one mistake, because each was written thinking about one file at a time.
   *
   * Transitive, because a dependent may itself be a base for something else. Bounded by the cache,
   * which only holds open documents.
   */
  const invalidateDependents = (uri: string): void => {
    const dropped = new Set<string>([uri]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [candidate, imports] of importsOf) {
        if (dropped.has(candidate)) continue;
        if (!imports.some((id) => dropped.has(id))) continue;
        dropped.add(candidate);
        changed = true;
      }
    }

    for (const id of dropped) {
      if (id === uri) continue;
      cache.delete(id);
      analyses.delete(id);
    }
  };

  return {
    open(uri, text) {
      documents.open(uri, text);
      invalidateDependents(uri);
    },
    change(uri, text) {
      documents.change(uri, text);
      invalidateDependents(uri);
    },
    close(uri) {
      documents.close(uri);
      cache.delete(uri);
      analyses.delete(uri);
      importsOf.delete(uri);
      /* Closing a document changes what its dependents resolve against — the buffer is gone and the
         host falls back to whatever is on disk, which may differ. */
      invalidateDependents(uri);
      /* A reopened document is a first sight again, which rebuilds its dependents once. That is the
         safe direction: nothing guarantees the file on disk is what was last compiled. */
      scheduler.forget(uri);
    },
    document: (uri) => documents.get(uri),
    compile,
    schedule: (uri) => scheduler.schedule(uri),

    rawDiagnostics(uri) {
      return compile(uri)?.diagnostics ?? [];
    },

    diagnostics(uri) {
      const document = documents.get(uri);
      const result = compile(uri);
      if (document === undefined || result === undefined) return [];
      return result.diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        message: d.message,
        range: document.rangeOf(d),
      }));
    },

    effectsOf(uri, fn) {
      const document = documents.get(uri);
      if (document === undefined || options.registry === undefined) return [];
      const parsed = parse(document.text, uri);
      if (parsed.diagnostics.length > 0) return [];
      const { effects } = checkEffects(parsed.module, options.registry, uri);
      return [...(effects.get(fn) ?? [])];
    },

    formatting(uri) {
      const document = documents.get(uri);
      if (document === undefined) return undefined;
      const result = format(document.text, uri);
      /* The formatter's own refusal is honoured: a file with a syntax error formats to itself, so
         an editor's format-on-save cannot mangle a file somebody is mid-way through typing. */
      return result.text;
    },

    hover(uri, offset) {
      const analysis = analysisOf(uri);
      return analysis === undefined
        ? null
        : hover(analysis, offset, options.registry, options.manifest);
    },

    definition(uri, offset) {
      const analysis = analysisOf(uri);
      return analysis === undefined ? null : definition(analysis, offset, uri, options.registry);
    },

    signatureHelp(uri, offset) {
      const analysis = analysisOf(uri);
      return analysis === undefined ? null : signatureHelp(analysis, offset, options.registry);
    },

    completions(uri, offset) {
      const analysis = analysisOf(uri);
      return analysis === undefined
        ? []
        : completions(analysis, offset, options.registry, options.manifest);
    },

    semanticTokens(uri) {
      const analysis = analysisOf(uri);
      return analysis === undefined
        ? []
        : semanticTokens(analysis, options.registry, options.manifest);
    },

    documentSymbols(uri) {
      const analysis = analysisOf(uri);
      return analysis === undefined ? [] : documentSymbols(analysis);
    },

    references(uri, offset) {
      const analysis = analysisOf(uri);
      return analysis === undefined ? [] : references(analysis, offset, options.registry);
    },

    rename(uri, offset, newName) {
      const analysis = analysisOf(uri);
      if (analysis === undefined) return { renamed: false, reason: 'no such document' };
      return rename(analysis, offset, newName, options.registry);
    },

    codeActions(uri) {
      const analysis = analysisOf(uri);
      const result = compile(uri);
      if (analysis === undefined || result === undefined) return [];
      return codeActions(analysis, result.diagnostics, options.manifest);
    },
  };
}

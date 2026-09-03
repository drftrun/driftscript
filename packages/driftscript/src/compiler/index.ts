/**
 * The build-side entry point. Everything a browser must never load lives behind this path.
 *
 * It is a separate `exports` entry rather than a folder convention because a bundler drops what the
 * module graph does not reach, and a convention reaches everything. The cost is that a consumer
 * importing from here in application code gets a parser in their bundle and no warning from
 * TypeScript; what notices is `scripts/size-gate.test.mjs`, which bundles a runtime-only fixture
 * and fails when the parser turns up in it.
 */
import type { Span } from './ast.ts';
import type { Diagnostic } from './diagnostics.ts';
import { check } from './check/checker.ts';
import { lower } from './ir/lower.ts';
import { emitJs } from './emit/js.ts';
import type { SourceMap } from './emit/sourceMap.ts';
import { parse } from './parser.ts';
import { interfaceHash } from './schema/interfaceHash.ts';
import { checkEffects } from './check/effects.ts';
import { linkCapabilities } from '../registry/link.ts';
import type { FnDecl } from './ast.ts';
import { checkAiAnnotations } from './check/annotations.ts';
import { checkUnits } from './check/units.ts';
import { checkChemistryAnnotations } from './check/chemistry.ts';
import { checkReplicatedFields } from './check/network.ts';
import { hotDiagnostics } from './check/hot.ts';
import type { CapabilityRegistry } from '../registry/capability.ts';
import type { ModuleHost } from './modules/host.ts';
import { resolveGraph } from './modules/graph.ts';
import { importedScope } from './modules/interface.ts';
import { effectsAcross, importedFor } from './modules/effects.ts';
import type { TargetManifest } from '../registry/manifest.ts';
import { namespaceOf } from './namespace.ts';

export type { Diagnostic, DiagnosticCode, Position } from './diagnostics.ts';
export { formatDiagnostic, positionAt } from './diagnostics.ts';
export { interfaceHash } from './schema/interfaceHash.ts';
export type { ModuleHost } from './modules/host.ts';
export { singleFileHost } from './modules/host.ts';
export type { InterfaceLedger, InterfaceMove } from './schema/ledger.ts';
export { createInterfaceLedger } from './schema/ledger.ts';
export type { ParseResult } from './parser.ts';
export { parse } from './parser.ts';

/*
 * The syntax tree and the token stream are part of the build-side surface.
 *
 * A language server needs both — it answers "what did the author write here", which the IR cannot
 * because it has erased units and expanded sugar. Exporting them here rather than letting the
 * server reach `src/compiler/parser.ts` directly is what keeps the entry point the boundary: a
 * consumer reaching an internal path is depending on something that will move.
 */
export type {
  DataDecl,
  Decl,
  EnumDecl,
  Expr,
  FnDecl,
  ImportDecl,
  Module,
  Span,
  Stmt,
  TypeRef,
} from './ast.ts';
export type { Token, TokenKind } from './lexer.ts';
export { tokenize } from './lexer.ts';
export {
  ANNOTATIONS,
  KEYWORDS,
  PRIMITIVES,
  PUNCTUATION,
  UNIT_SUFFIXES,
  isPrimitive,
  isSoftKeyword,
} from './tokens.ts';
export type { FormatResult } from './format/format.ts';
export { format } from './format/format.ts';
export type { EffectResult } from './check/effects.ts';
export { checkEffects } from './check/effects.ts';
export type { SourceMap } from './emit/sourceMap.ts';
/* The modules with no provider anywhere, so a host can assert its own list agrees with this one.
   Two lists of what is missing, maintained separately, is how a project advertises a hole it
   filled. */

/** The public name of this entry point, as a consumer's bundler config refers to it. */
export { SPECIFIED_MODULES } from '../registry/link.ts';

export const COMPILER_ENTRY = 'driftscript/compiler';

export interface CompileOptions {
  readonly filename: string;
  /**
   * The target to link against. **Optional, and its absence means nothing links and nothing is
   * refused.**
   *
   * That is the language-server and unit-test path: a compiler that demanded a manifest could not
   * report a syntax error without one, and an editor open on a file with no project configured
   * would show nothing rather than showing the errors it can see.
   */
  readonly manifest?: TargetManifest;
  /**
   * The capabilities this host describes, which is what effect inference reads.
   *
   * **Optional, and its absence means no effects are inferred and no annotation is checked.** That
   * is the same shape as `manifest`: a compiler that demanded one could not report a syntax error
   * without a fully described host, and an editor open on a file with no project configured would
   * show nothing rather than what it can see.
   *
   * A real build passes both. `@deterministic` on a file compiled with neither is a claim nothing
   * verified, which is why the Vite plugin's own documentation says to configure them.
   */
  readonly registry?: CapabilityRegistry;
  /**
   * How this compile reaches the modules it imports. **Required.**
   *
   * A deliberate departure from `manifest` and `registry` above, which are optional because their
   * absence means *nothing links and nothing is refused* — a real state, and the right one for a
   * first look. An absent host would mean something worse: a file with imports compiling to a
   * module missing them, silently, which is the shape `AGENTS.md`'s 2026-08-13 rule forbids.
   *
   * `singleFileHost()` is the honest answer when there is no project. It resolves nothing, so a
   * relative import is refused in words rather than dropped.
   */
  readonly host: ModuleHost;
  /**
   * Which build this is.
   *
   * **Read, as of the entity forms.** It was a required option `grep` found in two places — its
   * declaration and one assignment — and `IMPROVEMENTS.md` recorded it as a promise the compiler
   * had not kept. It now decides one thing: whether editor metadata rides in a module's `__drift`.
   *
   * That is deliberately the *payload* kind of difference rather than the *semantic* kind. The use
   * `IMPROVEMENTS.md` warns against is dropping the integer overflow helpers, which would give a
   * production build different behaviour; this changes what a shipping bundle carries and nothing
   * about what a program does.
   */
  readonly mode: 'development' | 'production';
  /**
   * Whether this build is allowed to skip capability linking and effect verification.
   *
   * **`mode: 'production'` requires a `manifest` and a `registry` unless this says otherwise**, and
   * that is the whole of the option. Without a manifest nothing links and nothing is refused;
   * without a registry no effect is inferred and `@deterministic` is a claim nothing checked — and
   * both were optional in every mode, so the easiest way to ship a build was one that had quietly
   * turned off the two guarantees a host buys this language for. A `.drs` file saying
   * `@deterministic` looked exactly the same either way.
   *
   * Development stays permissive and unchanged: a language server open on a file with no project
   * configured has to report the errors it can see rather than refusing to start, and that is a
   * real state rather than a misconfiguration.
   *
   * Named for what it does. A host that genuinely wants an unverified production build — a
   * playground, a syntax-only bundle — says so in a word nobody sets by accident, and the refusal
   * names this option so the way out is in the error.
   */
  readonly verification?: 'checked' | 'none';
  /**
   * This target's fixed simulation step, as steps per second. Defaults to 60.
   *
   * `update at 1Hz` is a *stride* by the time a backend sees it — how many fixed steps to skip —
   * and the number of steps in a second is what turns one into the other. It lived in the parser as
   * a constant, whose own comment said what would make that wrong: a host running a different fixed
   * step. That host compiles rates wrongly, silently, and there is nothing in the output to point
   * at afterwards.
   *
   * It reaches the module's metadata as well as the strides, so a module cached at 30 and loaded by
   * a host running at 60 can be told apart from one built for it.
   */
  readonly fixedStepsPerSecond?: number;
}

export interface DriftModuleMetadata {
  readonly module: string;
  readonly requires: readonly string[];
  /**
   * The resolved `.drs` files this module was compiled against.
   *
   * A bundler declares each as a watched dependency, which is the only thing holding the edge when
   * a file is imported for a type alone — a type is erased, so it emits no `import` for the module
   * graph to follow.
   */
  readonly imports: readonly string[];
  /** What a dependent depends on. A body-only edit leaves this identical. */
  readonly interfaceHash: string;
}

export interface CompileResult {
  readonly code: string;
  readonly map: SourceMap;
  readonly metadata: DriftModuleMetadata;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The imported names this module uses, rendered so a change to any of them moves its hash.
 *
 * A record contributes its fields, because a subtype inlines them; a function contributes its
 * parameter and return types, because a call is checked against them. Rendered from the resolved
 * types rather than from source, so a rename in the other file that does not change the shape does
 * not move this — and a reformat never does.
 */
function usedImports(scope: {
  data: ReadonlyMap<string, unknown>;
  enums: ReadonlyMap<string, unknown>;
  functions: ReadonlyMap<string, unknown>;
}): readonly string[] {
  /*
   * Cycle-safe, because `JSON.stringify` throws on a circular structure and this compiler does not
   * throw.
   *
   * Today no circular type graph reaches here — a module still being resolved publishes nothing, so
   * two records referring to each other across a module cycle never link up as objects. That is a
   * property of the resolver rather than of this function, and it is the kind of property that
   * changes without anybody thinking about this file. A repeat renders as a marker: enough to keep
   * the hash sensitive to shape, and no reason to visit it twice.
   */
  const shape = (value: unknown): string => {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (key, inner) => {
      if (key === 'span') return undefined;
      if (inner instanceof Map) return [...inner.entries()];
      if (typeof inner === 'object' && inner !== null) {
        if (seen.has(inner)) return '<seen>';
        seen.add(inner);
      }
      return inner;
    });
  };

  const out: string[] = [];
  for (const [name, type] of scope.data) out.push(`data ${name}=${shape(type)}`);
  for (const [name, type] of scope.enums) out.push(`enum ${name}=${shape(type)}`);
  for (const [name, signature] of scope.functions) out.push(`fn ${name}=${shape(signature)}`);
  return out;
}

const EMPTY_MAP = (filename: string, source: string): SourceMap => ({
  version: 3,
  file: `${filename}.js`,
  sources: [filename],
  sourcesContent: [source],
  names: [],
  mappings: '',
});

/**
 * Whether a stage's output should stop the pipeline.
 *
 * **Errors stop it; warnings do not.** A warning by definition describes something that is not
 * wrong — an unused import compiles perfectly — so stopping on one would mean a file with a
 * suggestion in it produced no code at all.
 *
 * This is not hypothetical: the guard was written as `diagnostics.length > 0` when every diagnostic
 * was an error, and the day the checker learned its first warning that line silently turned every
 * warned-about file into an empty module. Nothing caught it, because the build and the language
 * server agreed — they share this function.
 */
const stops = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'error');

const failed = (
  filename: string,
  source: string,
  diagnostics: readonly Diagnostic[],
): CompileResult => ({
  code: '',
  map: EMPTY_MAP(filename, source),
  metadata: { module: filename, requires: [], imports: [], interfaceHash: '' },
  diagnostics,
});

/**
 * Source to a JavaScript module, or to the reasons it is not one.
 *
 * **It never throws.** A source with errors returns empty code and populated diagnostics, because
 * a language server that gets an exception cannot show a squiggle and a build that gets one reports
 * a crash where it should report a mistake.
 *
 * **It stops at the first failing *stage*, not the first diagnostic.** Every stage reports
 * everything it can find, so a file with four type errors reports four. But a file with a syntax
 * error is not type-checked, because the recovered tree has holes in it and checking one produces
 * diagnostics about constructs nobody wrote — which is worse than silence, since a reader cannot
 * tell which of them is real.
 *
 * The cost is that fixing a syntax error can reveal type errors that were always there, so a bad
 * file takes two rounds. What would make that wrong is error recovery good enough that the tree
 * after a syntax error is worth drawing conclusions from, and this parser's recovery is
 * deliberately blunt for the same reason.
 */
/**
 * A production build that has nothing to verify against, refused before it produces anything.
 *
 * **Thrown rather than reported as a diagnostic**, and the distinction is who made the mistake. A
 * diagnostic is addressed to whoever wrote the `.drs` file and points at a span in it; this is a
 * host author's build configuration, there is no span, and the script is blameless. The build
 * process is where a person is watching, which is `AGENTS.md`'s rule about failing fast at init
 * read from the compiler's side.
 */
function refuseImpossibleStep(options: CompileOptions): void {
  const step = options.fixedStepsPerSecond;
  if (step === undefined) return;
  if (Number.isInteger(step) && step > 0) return;
  throw new Error(
    `\`fixedStepsPerSecond\` is how many fixed simulation steps a second holds, so it has to be a ` +
      `whole number above zero, and this is \`${step}\`. Every \`update at …Hz\` in every module ` +
      'compiled against this target divides it.',
  );
}

function refuseUnverifiedProduction(options: CompileOptions): void {
  if (options.mode !== 'production' || options.verification === 'none') return;

  const missing = [
    options.manifest === undefined ? '`manifest`' : null,
    options.registry === undefined ? '`registry`' : null,
  ].filter((name): name is string => name !== null);
  if (missing.length === 0) return;

  throw new Error(
    `a production build of \`${options.filename}\` was given no ${missing.join(' and no ')}. ` +
      'Without a manifest nothing links and no missing capability is refused; without a registry ' +
      'no effect is inferred and `@deterministic` is a claim nothing checked. Pass them, or pass ' +
      "`verification: 'none'` to say that this build is deliberately unverified.",
  );
}

export function compileDriftScript(source: string, options: CompileOptions): CompileResult {
  const { filename } = options;
  refuseImpossibleStep(options);
  refuseUnverifiedProduction(options);

  /* Warnings from every stage travel with a successful compile, so a file that compiles *and* has
     something to say still says it. Dropping them on success is the mirror of stopping on them. */
  const warnings: Diagnostic[] = [];

  const parsed = parse(source, filename, options.fixedStepsPerSecond);
  if (stops(parsed.diagnostics)) return failed(filename, source, parsed.diagnostics);
  warnings.push(...parsed.diagnostics);

  /*
   * The module graph is resolved after parsing and before checking.
   *
   * After parsing, because the imports to follow are in the tree. Before checking, because an
   * imported declaration has to be in scope for the first type annotation that names it — and a
   * module that does not resolve makes every name it would have published unknown, which is a
   * cascade of type errors about a single missing file.
   *
   * A file with no relative imports resolves a graph of one, which costs a parse it has already
   * done. That is the price of one code path rather than two, and two is how a rarely-taken branch
   * becomes wrong without anybody noticing.
   */
  const graph = resolveGraph(filename, source, options.host);
  if (stops(graph.diagnostics)) return failed(filename, source, graph.diagnostics);
  warnings.push(...graph.diagnostics);

  const imported = importedScope(graph, filename);
  if (stops(imported.diagnostics)) return failed(filename, source, imported.diagnostics);
  warnings.push(...imported.diagnostics);

  const checked = check(parsed.module, filename, options.registry, imported.scope);
  if (stops(checked.diagnostics)) return failed(filename, source, checked.diagnostics);
  warnings.push(...checked.diagnostics);

  /*
   * Effects are checked after types and before linking.
   *
   * After types, because an effect is attributed to a call and a call has to resolve first. Before
   * linking, because an annotation that lies is wrong whether or not this target provides the
   * capability — the design's rule that an effect is a property of the code and availability is a
   * property of the target, read as an ordering.
   */
  if (options.registry !== undefined) {
    /*
     * The graph settles first, then this file is checked against what settled.
     *
     * A module in a cycle has no final effect set until every module in that cycle does, so the
     * annotation on the file being compiled cannot be judged from the file alone. The settling
     * discards its own diagnostics: the ones that count are the ones reported here, against the
     * file somebody asked about, rather than the same message repeated once per round.
     */
    const settled = effectsAcross(graph, options.registry);
    const effects = checkEffects(
      parsed.module,
      options.registry,
      filename,
      importedFor(graph, settled, filename),
    );
    if (stops(effects.diagnostics)) return failed(filename, source, effects.diagnostics);
    warnings.push(...effects.diagnostics);
  }

  const ir = lower(
    parsed.module,
    checked,
    imported.scope,
    imported.records,
    imported.requires,
    filename,
  );

  /*
   * The hot-path check runs **after lowering**, because an allocation is a property of what the
   * backend emits rather than of what an author wrote: a `match` looks free in source and emits a
   * function call on an arrow. Its diagnostics are appended rather than woven in, which is what
   * running late costs.
   */
  /*
   * `@aiTool` and `@aiContext`, checked against the signatures the checker validated.
   *
   * Before the hot-path pass rather than after, because a tool whose arguments cannot
   * be expressed is a problem with the declaration and an allocation is a problem with
   * the body — and a reader shown the second first would fix the wrong thing.
   */
  const ai = checkAiAnnotations(
    parsed.module.decls.filter((decl): decl is FnDecl => decl.kind === 'fn'),
    filename,
  );
  if (ai.diagnostics.length > 0) return failed(filename, source, ai.diagnostics);

  /*
   * `degC` where a difference belongs, which is the one unit in this language that can be silently
   * wrong. See `check/units.ts` — it runs over the parsed tree rather than the IR, because by the
   * time lowering has erased the suffix there is nothing left to refuse.
   */
  const units = checkUnits(parsed.module, filename);
  if (units.length > 0) return failed(filename, source, units);

  /* `@substance` and `@reaction` against the records they sit on — a shape check rather than a
     language form, per `§20.7`. See `check/chemistry.ts` for why the element balance is not here. */
  const chemistry = checkChemistryAnnotations(parsed.module.decls, filename);
  if (chemistry.length > 0) return failed(filename, source, chemistry);

  /* `@replicated`, checked against the field it sits on. See `check/network.ts` for why a `data`
     record and a `String` are both refused, and why an `Entity` is not. */
  const replicated = checkReplicatedFields(parsed.module.decls, filename);
  if (replicated.length > 0) return failed(filename, source, replicated);

  /*
   * **Keyed by the name this file calls the module, not by the module's own.** An IR callee is
   * `${namespace}.${name}` as written, so a file that imported `drift/audio` under another name
   * would miss every entry of a table keyed by the path — and miss it silently, since a lookup that
   * finds nothing is a call this pass has no opinion about. `ir.namespaces` is the file's own
   * answer and already carries both halves.
   */
  const aliases = new Map(ir.namespaces.map((namespace) => [namespace.module, namespace.alias]));
  const hot = hotDiagnostics(
    ir,
    options.registry === undefined
      ? undefined
      : new Map(
          options.registry
            .all()
            .map((capability) => [
              `${aliases.get(capability.module) ?? namespaceOf(capability.module)}.${capability.name}`,
              { effects: capability.effects, allocates: capability.allocates },
            ]),
        ),
  );
  if (hot.length > 0) {
    const asDiagnostics = hot.map((entry) => ({
      code: entry.code,
      severity: 'error' as const,
      message: entry.message,
      file: filename,
      start: entry.span.start,
      end: entry.span.end,
    }));
    return failed(filename, source, asDiagnostics);
  }

  if (options.manifest !== undefined) {
    /* Import spans, so a refusal's caret lands on the import rather than at the top of the file.
       Built here rather than carried on the IR because it is a diagnostic concern and the IR is
       what a backend reads — a backend has no use for where an import was written. */
    const spans = new Map<string, Span>();
    for (const decl of parsed.module.imports) {
      if (!spans.has(decl.module)) spans.set(decl.module, decl.span);
    }

    const link = linkCapabilities(
      ir.requires,
      options.manifest,
      spans,
      filename,
      imported.through,
      options.registry,
    );
    if (!link.linked) return failed(filename, source, link.diagnostics);
  }

  const emitted = emitJs(ir, {
    filename,
    source,
    mode: options.mode,
    fixedStepsPerSecond: options.fixedStepsPerSecond,
  });

  return {
    code: emitted.code,
    map: emitted.map,
    metadata: {
      module: filename,
      requires: ir.requires,
      /*
       * The **resolved** ids, not the specifiers as written.
       *
       * Both callers want an identity they can compare and watch: a bundler declares each as a
       * watched file, and the language server matches them against document uris to know who
       * depends on whom. A specifier is neither — `./traits` means a different file from every
       * directory, so two modules importing "./traits" would look like they shared a dependency.
       */
      imports: graph.modules.get(filename)?.imports.map((i) => i.id) ?? [],
      interfaceHash: interfaceHash(ir, usedImports(imported.scope)),
    },
    diagnostics: warnings,
  };
}

/**
 * What an editor shows, computed from compiler facts.
 *
 * Every function here is a *presentation* of something the compiler or the registry already knows.
 * None of them decides anything: a completion's availability comes from the target manifest, a
 * hover's effects come from the capability definition, a semantic token's determinism comes from
 * the same set the checker uses. Where one of these would have to make a judgement, it asks instead.
 *
 * That is the same discipline the diagnostics follow, and for the same reason: a second opinion
 * inside an editor is a second opinion that will eventually differ from the build.
 */
import type { CapabilityRegistry, Effect, TargetManifest } from 'driftscript';
import { providesModule } from 'driftscript';
import type { FnDecl, Span, Token } from 'driftscript/compiler';
import { KEYWORDS, PRIMITIVES } from 'driftscript/compiler';
import { type Analysis, type Declaration, targetAt, tokenAt, typeText } from './analysis.ts';

export interface Hover {
  readonly contents: string;
  readonly span: Span;
}

/**
 * What a symbol is, in words.
 *
 * A capability's hover is the one that earns its keep: a script author reading `audio.play` wants
 * its signature, what it does to the world, and whether a deterministic function may call it —
 * three facts that live in three different places and that nobody would otherwise assemble.
 */
export function hover(
  analysis: Analysis,
  offset: number,
  registry?: CapabilityRegistry,
  manifest?: TargetManifest,
): Hover | null {
  const target = targetAt(analysis, offset, registry);

  switch (target.kind) {
    case 'capability': {
      const { definition } = target;
      const lines = [
        `${definition.module}.${definition.name}`,
        '',
        definition.signature,
        '',
        definition.doc,
        '',
        `effects: ${definition.effects.join(', ')}`,
        `deterministic: ${definition.deterministic ? 'yes' : 'no'}`,
      ];
      if (manifest !== undefined) {
        lines.push(
          providesModule(manifest, definition.module)
            ? `provided by target \`${manifest.name}\``
            : `**not provided by target \`${manifest.name}\`** — this will not link`,
        );
      }
      return { contents: lines.join('\n'), span: target.token };
    }

    case 'namespace': {
      const provided =
        manifest === undefined
          ? ''
          : providesModule(manifest, target.module)
            ? `\n\nprovided by target \`${manifest.name}\``
            : `\n\n**not provided by target \`${manifest.name}\`** — this will not link`;
      return {
        contents: `module \`${target.module}\`, bound as \`${target.alias}\`${provided}`,
        span: target.token,
      };
    }

    case 'declaration':
      return { contents: target.declaration.detail, span: target.token };

    case 'primitive':
      return { contents: `\`${target.name}\` — a primitive type`, span: target.token };

    default:
      return null;
  }
}

export interface Location {
  readonly uri: string;
  readonly span: Span;
}

/** Where a name is declared. Capabilities have no source location; they are described, not written. */
export function definition(
  analysis: Analysis,
  offset: number,
  uri: string,
  registry?: CapabilityRegistry,
): Location | null {
  const target = targetAt(analysis, offset, registry);
  if (target.kind === 'declaration') {
    return { uri, span: target.declaration.nameSpan };
  }
  if (target.kind === 'namespace' || target.kind === 'capability') {
    /*
     * A capability's "definition" is its import, which is the only place in *this* file that a
     * jump can land.
     *
     * The real definition is a `defineCapability` call in the host's TypeScript, which is a
     * different language in a different package — the design's registry-boundary case. Jumping to
     * the import is the honest answer: it is where this file said it wanted the thing.
     */
    const module =
      target.kind === 'namespace' ? target.module : target.definition.module;
    for (const [, namespace] of analysis.namespaces) {
      if (namespace.module === module) return { uri, span: namespace.span };
    }
  }
  return null;
}

export interface CompletionItem {
  readonly label: string;
  readonly kind: 'capability' | 'keyword' | 'type' | 'function' | 'module';
  /** Whether the configured target links it. An unavailable item is offered and marked, not hidden. */
  readonly available: boolean;
  readonly detail: string;
}

/**
 * What can be written here, including what cannot yet be linked.
 *
 * **An unavailable capability is offered and marked, never hidden**, and that is the whole design of
 * this feature. Hiding it teaches a script author that the surface does not exist; showing it greyed
 * with the reason teaches them it exists and their target does not provide it — which is true, is
 * actionable, and is the same thing the linker would tell them thirty seconds later.
 *
 * A consumer-defined capability completes here without this package knowing anything about that
 * consumer, which is the payoff for the registry being one source of truth.
 */
export function completions(
  analysis: Analysis,
  offset: number,
  registry?: CapabilityRegistry,
  manifest?: TargetManifest,
): readonly CompletionItem[] {
  const token = tokenAt(analysis.tokens, offset);
  const index = token === null ? analysis.tokens.length : analysis.tokens.indexOf(token);

  /* After `namespace.`, the only thing that can follow is one of that module's capabilities. The
     dot may be the token under the cursor or the one before it, depending on whether the cursor
     sits on it or just after. */
  const dot = analysis.tokens[index]?.text === '.' ? index : index - 1;
  const owner = analysis.tokens[dot - 1];

  if (analysis.tokens[dot]?.text === '.' && owner !== undefined && registry !== undefined) {
    const namespace = analysis.namespaces.get(owner.text);
    if (namespace !== undefined) {
      const available = manifest === undefined || providesModule(manifest, namespace.module);
      return registry.forModule(namespace.module).map((definition) => ({
        label: definition.name,
        kind: 'capability' as const,
        available,
        detail: available
          ? `${definition.signature}  ${definition.effects.join(', ')}`
          : `${definition.signature}  — not provided by target \`${manifest?.name}\``,
      }));
    }
  }

  const items: CompletionItem[] = [];

  for (const keyword of KEYWORDS) {
    if (PRIMITIVES.includes(keyword as (typeof PRIMITIVES)[number])) continue;
    items.push({ label: keyword, kind: 'keyword', available: true, detail: 'keyword' });
  }
  for (const primitive of PRIMITIVES) {
    items.push({ label: primitive, kind: 'type', available: true, detail: 'primitive type' });
  }
  for (const declaration of analysis.declarations) {
    items.push({
      label: declaration.name,
      kind: declaration.kind === 'fn' ? 'function' : 'type',
      available: true,
      detail: declaration.detail,
    });
  }
  for (const [alias, namespace] of analysis.namespaces) {
    const available = manifest === undefined || providesModule(manifest, namespace.module);
    items.push({
      label: alias,
      kind: 'module',
      available,
      detail: available
        ? namespace.module
        : `${namespace.module} — not provided by target \`${manifest?.name}\``,
    });
  }

  return items;
}

export interface SemanticToken {
  readonly span: Span;
  readonly type: 'keyword' | 'type' | 'function' | 'capability' | 'number' | 'string' | 'comment' | 'annotation' | 'operator' | 'variable';
  readonly modifiers: readonly string[];
}

/**
 * Every token, classified, with the modifiers that make this a DriftScript server rather than a
 * generic one.
 *
 * Three modifiers carry information no other editor feature shows: the **effect** a capability call
 * has, whether the enclosing function is **deterministic**, and whether the target can **link** it.
 * A script author looking at a file can see which lines touch the world and which are pure, without
 * reading a signature — which is the thing a behaviour script is hardest to reason about.
 */
export function semanticTokens(
  analysis: Analysis,
  registry?: CapabilityRegistry,
  manifest?: TargetManifest,
): readonly SemanticToken[] {
  const out: SemanticToken[] = [];
  const declared = new Map(analysis.declarations.map((d) => [d.name, d]));

  /* Which function each offset falls inside, so a token can carry its enclosing determinism. */
  const deterministic: { span: Span }[] = analysis.module.decls
    .filter((d) => d.kind === 'fn' && d.annotations.includes('deterministic'))
    .map((d) => ({ span: d.span }));
  const hot: { span: Span }[] = analysis.module.decls
    .filter((d) => d.kind === 'fn' && d.annotations.includes('hot'))
    .map((d) => ({ span: d.span }));

  const enclosing = (offset: number, ranges: { span: Span }[]) =>
    ranges.some((r) => offset >= r.span.start && offset < r.span.end);

  analysis.tokens.forEach((token, index) => {
    if (token.kind === 'eof') return;
    const modifiers: string[] = [];
    if (enclosing(token.start, deterministic)) modifiers.push('deterministic');
    if (enclosing(token.start, hot)) modifiers.push('hot');

    const push = (type: SemanticToken['type'], extra: readonly string[] = []) =>
      out.push({ span: { start: token.start, end: token.end }, type, modifiers: [...modifiers, ...extra] });

    if (token.kind === 'comment') return push('comment');
    if (token.kind === 'string') return push('string');
    if (token.kind === 'number' || token.kind === 'unit') return push('number');
    if (token.kind === 'annotation') return push('annotation');
    if (token.kind === 'punct') return push('operator');

    if (token.kind === 'keyword') {
      return PRIMITIVES.includes(token.text as (typeof PRIMITIVES)[number])
        ? push('type')
        : push('keyword');
    }

    /* A capability call, which is the classification worth having. */
    const previous = analysis.tokens[index - 1];
    const owner = analysis.tokens[index - 2];
    if (previous?.text === '.' && owner !== undefined && registry !== undefined) {
      const namespace = analysis.namespaces.get(owner.text);
      const definition =
        namespace === undefined ? undefined : registry.get(namespace.module, token.text);
      if (definition !== undefined && namespace !== undefined) {
        const extra: string[] = [...definition.effects];
        if (manifest !== undefined && !providesModule(manifest, namespace.module)) {
          extra.push('unavailable');
        }
        return push('capability', extra);
      }
    }

    if (analysis.namespaces.has(token.text)) {
      const namespace = analysis.namespaces.get(token.text);
      const extra =
        manifest !== undefined && namespace !== undefined && !providesModule(manifest, namespace.module)
          ? ['unavailable']
          : [];
      return push('variable', extra);
    }

    const declaration = declared.get(token.text);
    if (declaration !== undefined) {
      return push(declaration.kind === 'fn' ? 'function' : 'type');
    }

    return push('variable');
  });

  return out;
}

/** The declaration tree, for an outline. */
export interface SignatureHelp {
  /** The whole signature, as one line, which is what an editor puts in the popup header. */
  readonly label: string;
  /** Each parameter as written, so a client can highlight the active one inside the label. */
  readonly parameters: readonly string[];
  /** Which parameter the cursor is in. Zero when the argument list is empty. */
  readonly activeParameter: number;
  readonly documentation?: string;
}

/** Where a call's open paren is, and which argument the cursor sits in. */
interface CallSite {
  readonly open: number;
  readonly argument: number;
}

/**
 * The call the cursor is inside, found by walking back through the tokens.
 *
 * **Depth is tracked rather than assumed**, in both directions. Walking back to the first `(` finds
 * the wrong call the moment an argument is itself a call, and counting every `,` back to that paren
 * counts the inner call's commas as this one's. `two(two(1, 2), 3)` is the case: a naive version
 * reports parameter 2 of a two-parameter function, which an editor renders as no highlight at all
 * and reads as the feature being broken rather than as an off-by-one.
 */
function callSiteAt(tokens: readonly Token[], offset: number): CallSite | null {
  let index = tokens.length - 1;
  while (index >= 0 && tokens[index].start >= offset) index -= 1;

  let depth = 0;
  let argument = 0;
  for (let i = index; i >= 0; i -= 1) {
    const text = tokens[i].text;
    if (text === ')' || text === ']' || text === '}') depth += 1;
    else if (text === '[' || text === '{') {
      if (depth === 0) return null;
      depth -= 1;
    } else if (text === '(') {
      if (depth === 0) return { open: i, argument };
      depth -= 1;
    } else if (text === ',' && depth === 0) argument += 1;
  }
  return null;
}

/**
 * The parameters of the call the cursor is in.
 *
 * A capability's come from the registry, which is the same place its hover and its completion come
 * from; a local function's come from the syntax tree rather than from the `detail` string the
 * symbol tree carries, because re-splitting a rendered string is a second parser for something the
 * tree already holds separately.
 */
export function signatureHelp(
  analysis: Analysis,
  offset: number,
  registry?: CapabilityRegistry,
): SignatureHelp | null {
  const site = callSiteAt(analysis.tokens, offset);
  if (site === null) return null;

  const callee = analysis.tokens[site.open - 1];
  if (callee === undefined) return null;

  /* `namespace.member(` — the two tokens before the callee say which module it belongs to. */
  const dot = analysis.tokens[site.open - 2];
  const alias = analysis.tokens[site.open - 3];
  if (dot?.text === '.' && alias !== undefined && registry !== undefined) {
    const namespace = analysis.namespaces.get(alias.text);
    const definition =
      namespace === undefined ? undefined : registry.get(namespace.module, callee.text);
    if (definition !== undefined) {
      const parameters = definition.params.map((p) => `${p.name}: ${p.type}`);
      return {
        label: `${definition.name}(${parameters.join(', ')}) -> ${definition.returns}`,
        parameters,
        activeParameter: site.argument,
        documentation: definition.doc,
      };
    }
    return null;
  }

  const declared = analysis.module.decls.find(
    (decl): decl is FnDecl => decl.kind === 'fn' && decl.name === callee.text,
  );
  if (declared === undefined) return null;

  const parameters = declared.params.map(
    (p) => `${p.name}: ${p.mutable ? 'mut ' : ''}${typeText(p.type)}`,
  );
  const returns = declared.returnType === undefined ? '' : ` -> ${typeText(declared.returnType)}`;
  return {
    label: `${declared.name}(${parameters.join(', ')})${returns}`,
    parameters,
    activeParameter: site.argument,
  };
}

export function documentSymbols(analysis: Analysis): readonly Declaration[] {
  return analysis.declarations;
}

export type { Effect };

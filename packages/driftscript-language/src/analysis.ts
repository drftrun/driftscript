/**
 * Finding what is at a position, shared by every editor feature.
 *
 * Each feature is about *presenting* a compiler fact. Finding which fact is one problem, solved
 * once here — otherwise hover, completion, definition and semantic tokens each grow their own
 * lookup and the four disagree about what the cursor is on, which is the class of editor bug that
 * feels like the tool is haunted.
 *
 * Works from the **token stream and the parsed module**, not from the IR. The IR has erased units
 * and expanded sugar, so it cannot answer "what did the author write here" — which is the only
 * question an editor ever asks.
 */
import { type Module, type Span } from 'driftscript/compiler';
import { type Token, parse, tokenize } from 'driftscript/compiler';
import type { CapabilityDefinition, CapabilityRegistry } from 'driftscript';

/** A declaration a file makes, flattened for the features that list or jump to them. */
export interface Declaration {
  readonly kind: 'data' | 'enum' | 'fn' | 'field' | 'variant' | 'constant';
  readonly name: string;
  /** The whole declaration, for a symbol tree. */
  readonly span: Span;
  /** Just the name, for go-to-definition and rename. */
  readonly nameSpan: Span;
  readonly detail: string;
  readonly children: readonly Declaration[];
}

export interface Analysis {
  readonly module: Module;
  readonly tokens: readonly Token[];
  readonly declarations: readonly Declaration[];
  /** Namespace alias to the module it binds, from the imports. */
  readonly namespaces: ReadonlyMap<string, { module: string; names: ReadonlySet<string>; span: Span }>;
  readonly parsed: boolean;
}

/**
 * Analyse a document.
 *
 * **A file that does not parse still yields tokens and whatever declarations survived**, which is
 * what keeps highlighting and completion working while somebody is typing. An editor that goes
 * blank on the first unbalanced brace is an editor people turn off.
 */
export function analyse(text: string, uri: string): Analysis {
  const { tokens } = tokenize(text, uri);
  const { module, diagnostics } = parse(text, uri);

  const namespaces = new Map<string, { module: string; names: Set<string>; span: Span }>();
  for (const decl of module.imports) {
    const alias = decl.module.split('/').pop() ?? decl.module;
    const existing = namespaces.get(alias);
    const names = new Set(existing?.names ?? []);
    for (const name of decl.names) names.add(name);
    namespaces.set(alias, { module: decl.module, names, span: decl.span });
  }

  const declarations: Declaration[] = [];
  for (const decl of module.decls) {
    /*
     * The name's span is derived from the declaration's, by finding the name token inside it.
     *
     * The parser records where a declaration starts and ends but not where its name sits, because
     * nothing in the compiler needed that — go-to-definition is the first thing that does. Finding
     * it here rather than widening the AST keeps a field off every node for one consumer's sake.
     */
    /* An `on` handler declares no name of its own, so the outline anchors on the event it
       listens for — which is what a reader is scanning the list to find. */
    const declared = decl.kind === 'on' ? decl.event : decl.name;
    const nameSpan = nameSpanIn(tokens, decl.span, declared);

    if (decl.kind === 'data') {
      declarations.push({
        kind: 'data',
        name: decl.name,
        span: decl.span,
        nameSpan,
        /* The base belongs in the outline. A subtype shown as `data Wolf` hides the half of its
           shape that is not written in it — which is most of it, once a chain is two deep. */
        detail: decl.base === undefined ? `data ${decl.name}` : `data ${decl.name} : ${decl.base.name}`,
        children: decl.fields.map((field) => ({
          kind: 'field' as const,
          name: field.name,
          span: field.span,
          nameSpan: nameSpanIn(tokens, field.span, field.name),
          detail: field.name,
          children: [],
        })),
      });
    } else if (decl.kind === 'enum') {
      declarations.push({
        kind: 'enum',
        name: decl.name,
        span: decl.span,
        nameSpan,
        detail: `enum ${decl.name}`,
        children: decl.variants.map((variant) => ({
          kind: 'variant' as const,
          name: variant.name,
          span: variant.span,
          nameSpan: nameSpanIn(tokens, variant.span, variant.name),
          detail: variant.name,
          children: [],
        })),
      });
    } else if (decl.kind === 'event') {
      declarations.push({
        kind: 'data',
        name: decl.name,
        span: decl.span,
        nameSpan,
        detail: `event ${decl.name}`,
        children: decl.fields.map((field) => ({
          kind: 'field' as const,
          name: field.name,
          span: field.span,
          nameSpan: nameSpanIn(tokens, field.span, field.name),
          detail: field.name,
          children: [],
        })),
      });
    } else if (decl.kind === 'state') {
      declarations.push({
        kind: 'data',
        name: decl.name,
        span: decl.span,
        nameSpan,
        detail: `state ${decl.name}`,
        children: decl.handlers.map((handler) => ({
          kind: 'fn' as const,
          name: handler.event,
          span: handler.span,
          nameSpan: nameSpanIn(tokens, handler.span, handler.event),
          detail: `on ${handler.event}`,
          children: [],
        })),
      });
    } else if (decl.kind === 'component') {
      /*
       * A component is outlined like a record, because that is what a reader is looking for in the
       * symbol list: the fields and their order. `from host` is in the detail rather than the kind,
       * since a declaration that asserts a shape and one that declares it hold the same fields and
       * a reader jumping to one wants the same thing from both.
       */
      declarations.push({
        kind: 'data',
        name: decl.name,
        span: decl.span,
        nameSpan,
        detail: `component ${decl.name}${decl.fromHost ? ' from host' : ''}`,
        children: decl.fields.map((field) => ({
          kind: 'field' as const,
          name: field.name,
          span: field.span,
          nameSpan: nameSpanIn(tokens, field.span, field.name),
          detail: field.name,
          children: [],
        })),
      });
    } else if (decl.kind === 'on') {
      declarations.push({
        kind: 'fn',
        name: decl.event,
        span: decl.span,
        nameSpan,
        detail: `on ${decl.event} as ${decl.binding}`,
        children: [],
      });
    } else if (decl.kind === 'entity') {
      /*
       * An entity outlines its `require` list and its own fields together, in source order, because
       * that is the shape of the declaration a reader is scanning for. The requires are `variant`
       * rather than `field`: they name something declared elsewhere, and giving them the field icon
       * would say this entity holds them.
       */
      declarations.push({
        kind: 'data',
        name: decl.name,
        span: decl.span,
        nameSpan,
        detail: `entity ${decl.name}`,
        children: [
          ...decl.requires.map((required) => ({
            kind: 'variant' as const,
            name: required.name,
            span: required.span,
            nameSpan: nameSpanIn(tokens, required.span, required.name),
            detail: `require ${required.name}`,
            children: [],
          })),
          ...decl.fields.map((field) => ({
            kind: 'field' as const,
            name: field.name,
            span: field.span,
            nameSpan: nameSpanIn(tokens, field.span, field.name),
            detail: field.name,
            children: [],
          })),
        ],
      });
    } else if (decl.kind === 'system') {
      /*
       * A system outlines like a function — it is a body that runs, and the schedule addresses it
       * by this name. The detail carries the stride, because "how often does this run" is the
       * question a reader scanning a list of systems is actually asking.
       */
      const rate = decl.everyTicks === 1 ? '' : ` every ${decl.everyTicks} ticks`;
      declarations.push({
        kind: 'fn',
        name: decl.name,
        span: decl.span,
        nameSpan,
        detail: `system ${decl.name}${rate}`,
        children: [
          ...decl.reads.map((read) => ({
            kind: 'variant' as const,
            name: read.name,
            span: read.span,
            nameSpan: nameSpanIn(tokens, read.span, read.name),
            detail: `reads ${read.name}`,
            children: [],
          })),
          ...decl.writes.map((written) => ({
            kind: 'variant' as const,
            name: written.name,
            span: written.span,
            nameSpan: nameSpanIn(tokens, written.span, written.name),
            detail: `writes ${written.name}`,
            children: [],
          })),
        ],
      });
    } else if (decl.kind === 'prefab') {
      /* A prefab outlines by the components it names rather than by their values: the values are
         what an editor shows, and the symbol list is for finding the declaration. */
      declarations.push({
        kind: 'data',
        name: decl.name,
        span: decl.span,
        nameSpan,
        detail: `prefab ${decl.name}`,
        children: decl.components.map((component) => ({
          kind: 'field' as const,
          name: component.name,
          span: component.span,
          nameSpan: nameSpanIn(tokens, component.span, component.name),
          detail: component.name,
          children: [],
        })),
      });
    } else if (decl.kind === 'fn' || decl.kind === 'task') {
      const annotations = decl.annotations.map((a) => `@${a}`).join(' ');
      const params = decl.params
        .map((p) => `${p.name}: ${p.mutable ? 'mut ' : ''}${typeText(p.type)}`)
        .join(', ');
      /* A task has no return type, and the outline says `task` rather than `fn` so a reader
         scanning the symbol list can see which declarations can suspend. */
      const returns =
        decl.kind === 'task' || decl.returnType === undefined
          ? ''
          : ` -> ${typeText(decl.returnType)}`;
      const head = decl.kind === 'task' ? 'task' : 'fn';
      declarations.push({
        kind: 'fn',
        name: decl.name,
        span: decl.span,
        nameSpan,
        detail: `${annotations === '' ? '' : `${annotations} `}${head} ${decl.name}(${params})${returns}`,
        children: [],
      });
    } else if (decl.kind === 'const') {
      /* A module constant reads as a constant in an outline rather than as a variable: it is the
         one binding in the language that cannot be written to, and the symbol says so. */
      declarations.push({
        kind: 'constant',
        name: decl.name,
        span: decl.span,
        nameSpan,
        detail: `let ${decl.name}${decl.type === undefined ? '' : `: ${typeText(decl.type)}`}`,
        children: [],
      });
    } else {
      /*
       * **Exhaustive on purpose, and this replaced a bare `else`.**
       *
       * The chain used to end with `else` meaning "a function or a task", so every declaration the
       * language grew fell into it and failed as a type error *inside* the function branch —
       * reading as though `annotations` were missing from `FnDecl` rather than as a branch nobody
       * had written. Two declarations in a row landed there while the entity forms were added.
       *
       * `never` puts the error at the branch, naming the kind that has no case.
       */
      const unhandled: never = decl;
      throw new Error(`no outline for declaration kind \`${(unhandled as { kind: string }).kind}\``);
    }
  }

  return { module, tokens, declarations, namespaces, parsed: diagnostics.length === 0 };
}

/** A type as an editor shows it, reconstructed from what was written. */
export function typeText(ref: {
  kind: string;
  name?: string;
  args?: readonly unknown[];
  inner?: unknown;
}): string {
  if (ref.kind === 'option') {
    return `${typeText(ref.inner as Parameters<typeof typeText>[0])}?`;
  }
  const args = (ref.args ?? []) as Parameters<typeof typeText>[0][];
  if (args.length === 0) return ref.name ?? '?';
  return `${ref.name}<${args.map(typeText).join(', ')}>`;
}

/** The span of the first token matching `name` inside `span`, or `span` itself if none does. */
function nameSpanIn(tokens: readonly Token[], span: Span, name: string): Span {
  for (const token of tokens) {
    if (token.start < span.start || token.end > span.end) continue;
    if (token.text === name) return { start: token.start, end: token.end };
  }
  return span;
}

/**
 * The token at an offset.
 *
 * **A token that *contains* the offset wins over one that merely ends at it**, and getting this
 * backwards is subtle. Every token's end is the next token's start, so a cursor placed on the first
 * character of `play` in `audio.play` is also at the end of the `.` — and the naive scan returns
 * the dot. Hover then shows nothing, because a dot is nothing, and the bug reads as "hover does not
 * work on capabilities" rather than as an off-by-one.
 *
 * The end-of-token case is still answered, second, because a cursor immediately after a word is a
 * cursor on that word as far as a person is concerned — which is what completion needs when the
 * caret sits just past what has been typed.
 */
export function tokenAt(tokens: readonly Token[], offset: number): Token | null {
  let touching: Token | null = null;
  for (const token of tokens) {
    if (token.kind === 'eof') continue;
    if (offset >= token.start && offset < token.end) return token;
    if (offset === token.end) touching = token;
  }
  return touching;
}

/** The token before an offset, skipping the one containing it. Used to read `namespace.` context. */
export function tokenBefore(tokens: readonly Token[], offset: number): Token | null {
  let previous: Token | null = null;
  for (const token of tokens) {
    if (token.kind === 'eof') break;
    if (token.end > offset) return previous;
    previous = token;
  }
  return previous;
}

/**
 * What the cursor is on, resolved to something a feature can show.
 *
 * `capability` is the interesting case and the reason this returns a union rather than a token: an
 * editor showing `play` needs the *definition*, and finding it means knowing the token before is a
 * `.` and the one before that is a namespace. Doing that in four features is doing it wrong four
 * times.
 */
export type Target =
  | { readonly kind: 'capability'; readonly definition: CapabilityDefinition; readonly token: Token }
  | { readonly kind: 'namespace'; readonly alias: string; readonly module: string; readonly token: Token }
  | { readonly kind: 'declaration'; readonly declaration: Declaration; readonly token: Token }
  | { readonly kind: 'primitive'; readonly name: string; readonly token: Token }
  | { readonly kind: 'keyword'; readonly token: Token }
  | { readonly kind: 'none' };

export function targetAt(
  analysis: Analysis,
  offset: number,
  registry?: CapabilityRegistry,
): Target {
  const token = tokenAt(analysis.tokens, offset);
  if (token === null) return { kind: 'none' };

  const index = analysis.tokens.indexOf(token);
  const previous = analysis.tokens[index - 1];
  const twoBack = analysis.tokens[index - 2];

  /* `namespace.member` — the member is what the cursor is on. */
  if (
    previous?.text === '.' &&
    twoBack !== undefined &&
    analysis.namespaces.has(twoBack.text) &&
    registry !== undefined
  ) {
    const namespace = analysis.namespaces.get(twoBack.text);
    const definition = registry.get(namespace?.module ?? '', token.text);
    if (definition !== undefined) return { kind: 'capability', definition, token };
  }

  if (analysis.namespaces.has(token.text)) {
    const namespace = analysis.namespaces.get(token.text);
    return {
      kind: 'namespace',
      alias: token.text,
      module: namespace?.module ?? '',
      token,
    };
  }

  const declaration = findDeclaration(analysis.declarations, token.text);
  if (declaration !== null) return { kind: 'declaration', declaration, token };

  if (token.kind === 'keyword') {
    const PRIMITIVES = new Set([
      'bool', 'i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'f32', 'f64', 'String',
    ]);
    if (PRIMITIVES.has(token.text)) return { kind: 'primitive', name: token.text, token };
    return { kind: 'keyword', token };
  }

  return { kind: 'none' };
}

function findDeclaration(
  declarations: readonly Declaration[],
  name: string,
): Declaration | null {
  for (const declaration of declarations) {
    if (declaration.name === name) return declaration;
    const child = findDeclaration(declaration.children, name);
    if (child !== null) return child;
  }
  return null;
}

/**
 * Finding uses, renaming, and the fixes an editor can offer for a diagnostic.
 *
 * These are the features that *change* a file rather than describe it, so each one's refusal
 * matters more than its success. A rename that silently does the wrong thing is worse than one that
 * declines, because the wrong thing is applied across a file and reviewed as a mechanical edit.
 */
import type { Diagnostic, Span } from 'driftscript/compiler';
import type { CapabilityRegistry, TargetManifest } from 'driftscript';
import { type Analysis, targetAt } from './analysis.ts';

export interface TextEdit {
  readonly span: Span;
  readonly text: string;
}

export type RenameResult =
  | { readonly renamed: true; readonly edits: readonly TextEdit[] }
  | { readonly renamed: false; readonly reason: string };

/**
 * Every place a name is written, in this file.
 *
 * **Matched by token text, and the limits of that are stated rather than discovered.** Two things
 * it does not model:
 *
 * - **Shadowing.** `let Door = 1` inside a function shadows a record called `Door`, and both are
 *   reported. `rename` refuses in exactly that case rather than applying a wrong edit — which is
 *   why the limitation is survivable here and would not be if rename trusted this blindly.
 * - **Other files.** A project-wide search needs a project model, and the design puts that behind
 *   the incremental scheduler. A single-file answer that says so is more useful than none.
 *
 * A field name is deliberately included: `open` in `door.open` and `open` in the declaration are
 * the same name to a reader, and a reader is who this is for.
 */
export function references(analysis: Analysis, offset: number, registry?: CapabilityRegistry): readonly Span[] {
  const target = targetAt(analysis, offset, registry);

  const name =
    target.kind === 'declaration'
      ? target.declaration.name
      : target.kind === 'capability'
        ? target.definition.name
        : target.kind === 'namespace'
          ? target.alias
          : null;

  if (name === null) return [];

  return analysis.tokens
    .filter((token) => token.text === name && (token.kind === 'ident' || token.kind === 'keyword'))
    .map((token) => ({ start: token.start, end: token.end }));
}

/**
 * Rename a declaration, or refuse and say why.
 *
 * **A capability's name is not this file's to change**, and refusing is the whole point rather than
 * a missing feature. It is declared by a host in TypeScript, in another package, and possibly in
 * another repository; renaming it in a `.drs` file would rename nothing and break the call. The
 * refusal names where the definition actually lives, which is the thing somebody attempting the
 * rename wanted to know.
 *
 * It also refuses when a local binding shares the name, because `references` cannot tell them apart
 * and a rename that hit the wrong one would be applied across a file and reviewed as mechanical.
 * A conservative refusal is recoverable; a wrong edit is not.
 */
export function rename(
  analysis: Analysis,
  offset: number,
  newName: string,
  registry?: CapabilityRegistry,
): RenameResult {
  const target = targetAt(analysis, offset, registry);

  if (target.kind === 'capability') {
    return {
      renamed: false,
      reason:
        `\`${target.definition.name}\` is a capability declared by \`${target.definition.module}\`, ` +
        'not by this file. Its name belongs to the host that registered it; renaming it here would ' +
        'rename nothing and break the call.',
    };
  }

  if (target.kind === 'namespace') {
    return {
      renamed: false,
      reason:
        `\`${target.alias}\` is bound by importing \`${target.module}\`, so its name follows the ` +
        'module. Change the import to change the namespace.',
    };
  }

  if (target.kind === 'primitive' || target.kind === 'keyword') {
    return { renamed: false, reason: `\`${target.token.text}\` is part of the language.` };
  }

  if (target.kind !== 'declaration') {
    return { renamed: false, reason: 'there is nothing to rename here' };
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
    return { renamed: false, reason: `\`${newName}\` is not a valid name` };
  }

  const clash = analysis.declarations.find(
    (declaration) => declaration.name === newName && declaration !== target.declaration,
  );
  if (clash !== undefined) {
    return { renamed: false, reason: `\`${newName}\` is already declared in this file` };
  }

  const spans = references(analysis, offset, registry);
  return { renamed: true, edits: spans.map((span) => ({ span, text: newName })) };
}

export interface CodeAction {
  readonly title: string;
  readonly diagnostic: string;
  readonly edits: readonly TextEdit[];
  /** A change a consumer must make outside this file, which no edit here can perform. */
  readonly manual?: string;
}

/**
 * What an editor can offer for a diagnostic.
 *
 * **The one for an unprovided module cannot be an edit**, and saying so is more useful than
 * offering nothing. A target manifest lives in a consumer's build configuration — TypeScript, in
 * another file this server has never been shown — so the action carries the instruction rather than
 * a change. An action that silently did nothing would be worse than its absence.
 */
export function codeActions(
  analysis: Analysis,
  diagnostics: readonly Diagnostic[],
  manifest?: TargetManifest,
): readonly CodeAction[] {
  const actions: CodeAction[] = [];

  for (const diagnostic of diagnostics) {
    if (diagnostic.code === 'DS0301') {
      const module = /`([^`]+)` is not provided/.exec(diagnostic.message)?.[1];
      if (module === undefined) continue;
      actions.push({
        title: `Add \`${module}\` to the target manifest`,
        diagnostic: diagnostic.code,
        edits: [],
        manual:
          `Add \`${module}\` to the \`provides\` list of target ` +
          `\`${manifest?.name ?? 'your target'}\`, which lives in your build configuration.`,
      });
      continue;
    }

    if (diagnostic.code === 'DS0290') {
      const name = /`([^`]+)` is imported/.exec(diagnostic.message)?.[1];
      if (name === undefined) continue;
      const edit = removeImportedName(analysis, diagnostic, name);
      if (edit !== null) {
        actions.push({
          title: `Remove the unused import \`${name}\``,
          diagnostic: diagnostic.code,
          edits: [edit],
        });
      }
      continue;
    }

    if (diagnostic.code === 'DS0235') {
      const name = /`([^`]+)` is not imported/.exec(diagnostic.message)?.[1];
      const module = /from `([^`]+)`/.exec(diagnostic.message)?.[1];
      if (name === undefined || module === undefined) continue;
      const edit = addImportedName(analysis, module, name);
      if (edit !== null) {
        actions.push({
          title: `Add \`${name}\` to the import from \`${module}\``,
          diagnostic: diagnostic.code,
          edits: [edit],
        });
      }
    }
  }

  return actions;
}

/**
 * The edit that drops one name from an import list.
 *
 * The comma goes with it, and which comma depends on where the name sits: a trailing name takes the
 * one before it, any other takes the one after. Getting that wrong leaves `import { , stop }`,
 * which is a syntax error introduced by a fix — the worst thing a code action can do.
 */
function removeImportedName(analysis: Analysis, diagnostic: Diagnostic, name: string): TextEdit | null {
  const tokens = analysis.tokens;
  const index = tokens.findIndex(
    (token) => token.text === name && token.start >= diagnostic.start && token.end <= diagnostic.end,
  );
  if (index < 0) return null;

  const after = tokens[index + 1];
  const before = tokens[index - 1];

  /* The span runs to the *next token's start* rather than to the comma's end, so the whitespace
     after the comma goes with it. Stopping at the comma leaves `import {  play }` — valid, and a
     double space a formatter would then have to clean up after a fix that claimed to be tidy. */
  if (after?.text === ',') {
    const following = tokens[index + 2];
    return {
      span: { start: tokens[index].start, end: following?.start ?? after.end },
      text: '',
    };
  }
  if (before?.text === ',') return { span: { start: before.start, end: tokens[index].end }, text: '' };
  /* The only name in the list. Removing it would leave `import { } from …`, which parses but says
     nothing — so the action is not offered rather than offering a change that needs a second one. */
  return null;
}

/** The edit that adds a name to an existing import list, before its closing brace. */
function addImportedName(analysis: Analysis, module: string, name: string): TextEdit | null {
  for (const [, namespace] of analysis.namespaces) {
    if (namespace.module !== module) continue;
    const closing = analysis.tokens.find(
      (token) =>
        token.text === '}' && token.start >= namespace.span.start && token.end <= namespace.span.end,
    );
    if (closing === undefined) return null;
    return { span: { start: closing.start, end: closing.start }, text: `, ${name} ` };
  }
  return null;
}

/** Apply edits to a text, right to left so earlier offsets stay valid. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.span.start - a.span.start);
  let out = text;
  for (const edit of ordered) {
    out = out.slice(0, edit.span.start) + edit.text + out.slice(edit.span.end);
  }
  return out;
}

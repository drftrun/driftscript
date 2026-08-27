/**
 * `@editor(…)` checked against the field it sits on.
 *
 * **This is the half that is real with no editor in existence.** A range on a field that holds text
 * is wrong today; a range in metres on a field whose default is in seconds is wrong today; an
 * `assetType` on a number is wrong today. None of that needs a consumer — it needs the field, which
 * is right here.
 *
 * The other half, emitting the metadata, is the emitter's. Splitting them is what lets the check
 * land before any host provides an editor surface, and stay true whether or not one ever does.
 *
 * ---
 *
 * ## A field's unit comes from its default, because a type has none
 *
 * `sightRange: f64 = 40m` carries `m` on the *value*, not on the type — this language erases units
 * at compile time and has no unit-carrying type. So the only thing a range's unit can be checked
 * against is the default's, and a field with no default has nothing to disagree with. **What that
 * costs** is that a united range on a defaultless field is accepted whatever it says. **What would
 * make it wrong** is units becoming part of a type, at which point this reads the type instead.
 */
import type { EditorMeta, Expr, FieldDecl } from '../ast.ts';
import type { DiagnosticCode } from '../diagnostics.ts';
import type { Span } from '../ast.ts';
import type { Type } from './types.ts';

/** Types a `range:` can describe. A range over anything else is a range over nothing. */
function numeric(type: Type): boolean {
  if (type.kind === 'entity') return false;
  if (type.kind === 'option') return numeric(type.inner);
  return type.kind === 'primitive' && type.name !== 'bool' && type.name !== 'String';
}

/** Whether a type is one an asset can be named by. A resource is named by a string today. */
function nameable(type: Type): boolean {
  if (type.kind === 'option') return nameable(type.inner);
  return type.kind === 'primitive' && type.name === 'String';
}

/** The unit a default literal carries, when it is a bare literal. */
function unitOf(value: Expr | undefined): string | undefined {
  return value?.kind === 'number' ? value.unit : undefined;
}

export function checkEditorAnnotation(
  field: FieldDecl,
  type: Type,
  report: (code: DiagnosticCode, message: string, span: Span) => void,
): void {
  const editor: EditorMeta | undefined = field.editor;
  if (editor === undefined) return;

  if (editor.range !== undefined) {
    if (!numeric(type)) {
      report(
        'DS0292',
        `\`${field.name}\` is \`${type.kind === 'primitive' ? type.name : type.kind}\`, and a ` +
          '`range:` describes a numeric field. There is nothing for a slider to move between here.',
        editor.range.span,
      );
    } else if (editor.range.min > editor.range.max) {
      report(
        'DS0292',
        `this range runs from ${editor.range.min} down to ${editor.range.max}. A range whose ` +
          'bounds are the wrong way round leaves an editor nothing to show.',
        editor.range.span,
      );
    } else {
      const declared = unitOf(field.default);
      if (declared !== undefined && editor.range.unit !== declared) {
        report(
          'DS0293',
          `this range is in \`${editor.range.unit ?? 'no unit'}\` and \`${field.name}\` defaults to ` +
            `\`${declared}\`. A slider in one quantity over a field in another moves the value by ` +
            'the wrong amount, and nothing at runtime can tell.',
          editor.range.span,
        );
      }
    }
  }

  if (editor.assetType !== undefined && !nameable(type)) {
    report(
      'DS0294',
      `\`${field.name}\` is not text, so an \`assetType:\` has nothing to pick into it. An asset is ` +
        'named by a `String` field, which is what a picker would write.',
      editor.assetType.span,
    );
  }
}

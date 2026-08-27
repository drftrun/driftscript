/**
 * A record's schema: what a save file holds and what a migration matches on.
 *
 * `runtime/state.ts` states what a field id *is* and why. This is the half that builds one, and it
 * is in the compiler because that is the only place that knows which record declared a field —
 * a subtype's own fields and its base's are indistinguishable by the time either is a value.
 */
import type { FieldId, Schema } from '../../runtime/state.ts';
import { fieldId } from '../../runtime/state.ts';
import type { IrData, IrField } from '../ir/ir.ts';
import { typeKey } from './typeKey.ts';

/** The id of one field: its declaring record, and the name it keeps. */
export function idOf(field: IrField): FieldId {
  return fieldId(field.owner, field.pinned ?? field.name);
}

export function schemaOf(data: IrData): Schema {
  return {
    name: data.name,
    fields: data.fields.map((field) => ({
      id: idOf(field),
      name: field.name,
      type: typeKey(field.type),
    })),
  };
}

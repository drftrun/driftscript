/**
 * What a record's shape is, in the form a save file and a migration can hold.
 *
 * **A field id is `(declaring module, declaring record, field name)`, and never a position.** That
 * is fixed by §9 of the modules design, and the reasoning is worth having here beside the code:
 *
 * A positional id renumbers every field after an insertion, so a save loads the right names with
 * the wrong values — worse than failing, because it looks like it worked. Inheritance multiplies
 * it: a base gaining one field shifts the position of every own-field of **every subtype in the
 * project**, in every file, at once. One edit in one file would corrupt all of them.
 *
 * Keying to the record that *declares* the field makes a base insertion cost nothing to any
 * subtype. The subtype's own fields keep the ids they had, and the new base field arrives with an
 * id of its own.
 *
 * ---
 *
 * ## The id is a string, not a number
 *
 * The original plan specified `FieldId = number`. A number has to be *assigned*, which means a
 * registry of which numbers are taken and a way to carry it between compiles — a second source of
 * truth that a fresh checkout does not have. The triple is already unique and already stable, and
 * writing it down is the whole implementation.
 *
 * The cost is bytes in a save file: `demo/pulse.drs::Wave::phase` against `7`. **What would make it
 * wrong** is a consumer serialising millions of instances, where the id would be interned once and
 * referenced by index — which is a property of that *format*, not of the identity, and can be added
 * without moving what a field is called.
 */

/** `<module>::<Record>::<field>`. Stable across insertions, reorderings and a base's growth. */
export type FieldId = string;

export interface FieldSchema {
  readonly id: FieldId;
  readonly name: string;
  /**
   * The field's type, as a key rather than a structure.
   *
   * Migration needs to know whether two fields are the *same* type, not what that type can do, and
   * a key compares in one string equality. What would make it wrong is a migration that could
   * usefully convert between types, which is exactly what this refuses to guess.
   */
  readonly type: string;
}

export interface Schema {
  readonly name: string;
  readonly fields: readonly FieldSchema[];
}

/** Where a field was declared: the pair that makes its id stable. */
export function fieldId(owner: string, name: string): FieldId {
  return `${owner}::${name}`;
}

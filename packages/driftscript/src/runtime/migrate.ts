/**
 * Carrying a live instance across a change to the record it belongs to.
 *
 * **This is what turns `patchModule`'s refusal into a reload.** Until it existed, a record that
 * gained a field ended a hot patch in words naming the record — honest, and the whole reason an
 * author restarted the scene. Now the field arrives with its default and everything already there
 * keeps its value.
 *
 * ---
 *
 * ## Matching is by id, never by name and never by position
 *
 * `runtime/state.ts` states what a field id is. Here is what it buys: a field renamed with `@id`
 * carries its value across, a field inserted in the middle moves nothing, and a base gaining a
 * field leaves every subtype's own values where they were.
 *
 * ## A type change is refused, not coerced
 *
 * A field that was `f32` and is now `String` could be turned into `"0"`, and a consumer would find
 * a save that loaded without complaint and a world that behaved differently. Naming the field and
 * refusing is the only answer that cannot be mistaken for having worked. **What would make this
 * wrong** is a declared conversion — an author saying what the old value becomes — which is a
 * feature with a syntax, not a default a migration may assume.
 *
 * ## It is pure
 *
 * A new object comes back and the input is untouched, so a refusal halfway through cannot leave an
 * instance half-migrated. `patchModule` is what copies the result into the object a consumer holds,
 * because a consumer holds the reference and a replacement would strand it.
 */
import type { Schema } from './state.ts';

export type MigrationResult =
  | { readonly migrated: true; readonly value: Record<string, unknown> }
  | { readonly migrated: false; readonly reason: string };

/**
 * Build the new shape of one instance.
 *
 * `defaults` is a freshly constructed instance of the new record — what `createX()` returns. A
 * field the old shape did not have takes its value from there rather than from anything recorded in
 * the schema, and that is deliberate: a default may be computed, and the constructor is the only
 * thing that can compute it. A schema carrying a *value* would be right only for constants and
 * silently wrong for the rest.
 */
export function migrate(
  instance: unknown,
  from: Schema,
  to: Schema,
  defaults: Record<string, unknown>,
): MigrationResult {
  if (typeof instance !== 'object' || instance === null) {
    return { migrated: false, reason: `an instance of \`${from.name}\` is not an object` };
  }
  const previous = instance as Record<string, unknown>;

  const wasById = new Map(from.fields.map((field) => [field.id, field]));

  /* Every check before any write, so a refusal leaves nothing half-built — the same order
     `patchModule` compares shapes in, and for the same reason. */
  for (const field of to.fields) {
    const before = wasById.get(field.id);
    if (before !== undefined && before.type !== field.type) {
      return {
        migrated: false,
        reason:
          `\`${to.name}.${field.name}\` was \`${before.type}\` and is now \`${field.type}\`. A ` +
          'migration will not guess what the old value becomes, because a guess that loads without ' +
          'complaint is indistinguishable from having worked.',
      };
    }
  }

  const value: Record<string, unknown> = {};
  for (const field of to.fields) {
    const before = wasById.get(field.id);
    /* A field the old shape had, under whatever name it had then. A field it did not have takes
       the constructor's answer, which is where a computed default comes from. */
    value[field.name] =
      before !== undefined && before.name in previous
        ? previous[before.name]
        : defaults[field.name];
  }
  return { migrated: true, value };
}

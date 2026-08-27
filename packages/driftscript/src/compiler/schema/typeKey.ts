/**
 * A type as a key: one string, compared for equality.
 *
 * **Two things ask this question and they must get the same answer.** A migration asks whether a
 * value may carry between two fields; an interface hash asks whether a dependent must recompile.
 * Those are the same question — two fields are the same type exactly when a value may move between
 * them without conversion — and if they ever want different answers, one of them has stopped being
 * about identity.
 *
 * **That sentence was in `schema.ts` while this was two private copies**, one there and one in
 * `interfaceHash.ts`, identical and unconnected. They agreed only because neither had moved, which
 * is the drift this repository has a rule about, and the first change to either would have ended it
 * — as it did: making an option name its inner type in one place would have left the other calling
 * `f32?` and `String?` the same interface.
 *
 * ---
 *
 * ## An option names what it holds
 *
 * This returned `type.kind`, so every option keyed as `option` whatever it wrapped. Two
 * consequences, and both were live:
 *
 * - A migration could carry a `String` into an `Entity` field. A handle reconstructed from a string
 *   is a live-looking handle pointing at nothing, with no error anywhere.
 * - A module changing `fn read(v: f32?)` to `fn read(v: String?)` hashed identically, so a
 *   dependent would not have recompiled against an interface that had genuinely changed.
 *
 * **What this costs** is that a value saved against the old `option` key refuses to migrate. No
 * shipped `.drs` has an option-typed *record* field — checked when this landed; the options in the
 * corpus are all in function signatures, which no save file holds — so the cost is prospective.
 * **What would make it wrong** is a migration that could usefully convert between two types, which
 * is exactly what a key compared for equality refuses to guess.
 */
import type { IrType } from '../ir/ir.ts';

export function typeKey(type: IrType): string {
  if (type.kind === 'option') return `option:${typeKey(type.inner)}`;
  /* `Entity`, capitalised, because that is the key the entity model's column table uses — the two
     are one vocabulary and a scene load reads this to know which fields to remap. */
  if (type.kind === 'entity') return 'Entity';
  return type.kind === 'data' ? `data:${type.name}` : type.kind;
}

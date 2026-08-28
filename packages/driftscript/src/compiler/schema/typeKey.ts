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
  switch (type.kind) {
    case 'f32':
    case 'f64':
    case 'bool':
    case 'string':
    case 'void':
      return type.kind;
    case 'int':
      /*
       * **The width, not the word `int`.** This returned `type.kind`, so every integer type keyed
       * identically — and the consequences were the ones the option paragraph above describes,
       * one level worse.
       *
       * A migration would carry a `u8` into an `i64` and an `i64` into a `u8`, which is the
       * truncation the checked-conversion spellings exist to make a script ask for. An interface
       * changing `fn set(v: u8)` to `fn set(v: i64)` hashed the same, so no dependent recompiled.
       *
       * And a third, reaching outside this repository: a component field's type is this string, and
       * a host's column table is keyed by the width. The engine's is — `i8` is an `Int8Array` — so
       * it had no entry for `int`, and **every integer component field threw at bind**, naming a
       * type no script had written. Nothing in the corpus declared one, which is why it stood.
       */
      return type.name;
    case 'entity':
      /* `Entity`, capitalised, because that is the key the entity model's column table uses — the
         two are one vocabulary and a scene load reads this to know which fields to remap. */
      return 'Entity';
    case 'data':
      return `data:${type.name}`;
    case 'enum':
      /* Named for the same reason a record is: two enums are not one type, and a value of one is
         not a value of the other. */
      return `enum:${type.name}`;
    case 'list':
      return `list:${typeKey(type.of)}`;
    case 'option':
      return `option:${typeKey(type.inner)}`;
    case 'result':
      return `result:${typeKey(type.ok)}:${typeKey(type.err)}`;
    default:
      return unkeyed(type);
  }
}

/**
 * A type with no key, refused rather than given a shape-shaped one.
 *
 * Every caller compares this string for **equality**, so a type that fell through to a default
 * would be "the same type" as every other one that did — which is how `int` came to mean eight
 * widths and `enum` came to mean all of them at once.
 */
function unkeyed(type: never): never {
  throw new Error(
    `\`typeKey\` has no key for \`${(type as { kind: string }).kind}\`. Every caller compares ` +
      'these for equality, so a missing case makes two different types identical rather than ' +
      'unknown. Add one.',
  );
}

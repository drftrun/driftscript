/**
 * `@replicated`, checked against the field it sits on.
 *
 * **`§22` specified this annotation before any host could provide networking**, on the argument
 * that replication constrains state identity, serialization, authority, task semantics and RNG, and
 * that designing those without knowing what networking wants is how a language acquires a redesign.
 * The annotation has been a lexer token ever since and nothing has read it. DriftEngine's Track J
 * built the host in 2026-09, so this is where it starts meaning something.
 *
 * ---
 *
 * ## It registers nothing, which is the property the capability model rests on
 *
 * The same sentence `check/chemistry.ts` makes about `@substance`: registration is a host call, so a
 * file marking fields replicated still links against a target that provides no networking at all and
 * behaves exactly as it did. What this buys is a *shape check* — a field a host is expected to put
 * on a wire is checked for being the kind of thing a wire carries, at the declaration, rather than
 * by a value arriving somewhere as nonsense.
 *
 * ## Two rules, and both come from what replication actually is
 *
 * **A replicated field belongs to a `component`.** A `data` record is a value a function passes
 * around; a component is state an entity carries, which is what another peer needs a copy of.
 * Marking a local record replicated describes a thing with no identity to replicate *to*.
 *
 * **A replicated field holds a number.** A host's replication path carries scalars — DriftEngine's
 * is a table of them addressed by slot — because anything richer needs a schema on the wire, and a
 * schema on the wire is a versioning problem rather than a networking one. A `String` is refused for
 * the same reason it is a boxed column in an entity store: it is not bulk data, and a per-tick
 * string is a bandwidth decision nobody made on purpose.
 *
 * **`Entity` is allowed and is worth a sentence.** A handle is a number, so it crosses; whether it
 * *means* the same thing at the other end depends on the host's model. Two lockstep peers build the
 * same world and their handles agree; an authoritative host and its client do not, and a handle
 * there is a number that indexes a stranger. The compiler cannot tell which host it is being
 * compiled for, so it permits the field and this comment is where the caveat lives.
 */
import type { Decl, FieldDecl, Span, TypeRef } from '../ast.ts';
import type { Diagnostic } from '../diagnostics.ts';

/**
 * Types a replication path can carry, which is the numeric set plus `bool` and `Entity`.
 *
 * `f32` and `f64` are the ordinary cases. The integer widths are here because a discriminant, a
 * count and a lap number are all things a peer wants. `bool` is a byte. `Entity` is a number, with
 * the caveat in the header.
 */
const REPLICABLE: ReadonlySet<string> = new Set([
  'f32',
  'f64',
  'i8',
  'i16',
  'i32',
  'i64',
  'u8',
  'u16',
  'u32',
  'u64',
  'bool',
  'Entity',
]);

function describe(type: TypeRef): string {
  if (type.kind === 'option') return `${describe(type.inner)}?`;
  return type.name;
}

export function checkReplicatedFields(decls: readonly Decl[], file: string): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (message: string, span: Span): void => {
    diagnostics.push({
      code: 'DS0298',
      severity: 'error',
      message,
      file,
      start: span.start,
      end: span.end,
    });
  };

  for (const decl of decls) {
    if (!('fields' in decl) || !Array.isArray(decl.fields)) continue;
    const fields = decl.fields as readonly FieldDecl[];

    for (const field of fields) {
      if (field.replicated !== true) continue;

      if (decl.kind !== 'component') {
        report(
          `\`@replicated\` marks state another peer needs a copy of, and \`${decl.name}\` is a ` +
            `\`${decl.kind}\` rather than a \`component\`. A record passed between functions has ` +
            'no identity to replicate to; move the field onto the component the entity carries.',
          field.span,
        );
        continue;
      }

      /*
       * An option is refused rather than unwrapped, and the reason is on the wire rather than in the
       * type: a replicated optional needs a presence bit beside the value, which is a second thing
       * to keep in step across a version change. An entity store solves that with a column; a
       * packet has no column to put it in.
       */
      if (field.type.kind === 'option') {
        report(
          `\`${field.name}\` is optional, and \`@replicated\` carries a value rather than a value ` +
            'and a presence bit. Replicate a number that means "absent" — a negative count, a ' +
            'zero handle — so both peers agree what absence looks like.',
          field.span,
        );
        continue;
      }

      const name = describe(field.type);
      if (!REPLICABLE.has(name)) {
        report(
          `\`${field.name}\` is a \`${name}\`, and a replication path carries numbers. Anything ` +
            'richer needs a schema on the wire, which is a versioning problem rather than a ' +
            `networking one. Replicable types are ${[...REPLICABLE].join(', ')}.`,
          field.span,
        );
      }
    }
  }

  return diagnostics;
}

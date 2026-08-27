/**
 * `@substance` and `@reaction`, checked against the record they sit on.
 *
 * **`§20.7` asks why these are not language forms and answers it.** DS-5 and DS-6 added `component`,
 * `entity`, `system`, `query` and `prefab` as forms, so the question is a real one — and a form
 * earns its place when it needs scoping, effect inference, or a compiler-checked call graph.
 * `system` needed all three. A substance is a record of numbers: no control flow, no effects,
 * nothing to infer. What it needs is a **shape check**, so a misspelled field is a diagnostic here
 * rather than a `NaN` in an exponent twenty ticks into a burn — and that is exactly what `@editor`
 * already does for component metadata.
 *
 * **It registers nothing**, and that is the property the whole capability model rests on:
 * registration is a host call, so a `.drs` file that defines substances still links against a target
 * providing `drift/chemistry` and is refused by one that does not.
 *
 * ---
 *
 * ## The element balance is refused here, and it is worth saying where it went
 *
 * `§20.7` wanted `@reaction` to check the stoichiometry against the element matrix, and called it
 * "the one thing in this section that pays for itself". It cannot be done here. The formulas live in
 * `@driftengine/chemistry`'s species registry, and this package **imports no engine package at all**
 * — a property asserted three separate ways, and the reason the language can be checked against
 * capabilities that have not shipped. The compiler has the subscripts of nothing.
 *
 * **The check is not lost, only late.** `ReactionRegistry.register` already refuses an unbalanced
 * reaction naming the element and the size of the gap, at init, with the same words. What would
 * reverse this is a host-supplied schema carrying formulas, at which point this reads it.
 */
import type { DataDecl, Decl, FieldDecl, Span, TypeRef } from '../ast.ts';
import type { Diagnostic } from '../diagnostics.ts';

/** A required field, as the name a record must carry and the type it must carry it at. */
interface Required {
  readonly name: string;
  readonly type: string;
}

/**
 * What a substance record must carry, and it is `SubstanceThermal`'s own set narrowed to what a
 * script can state as a literal.
 *
 * `composition` and `reactions` are **not** here, and that is not an omission: a composition is
 * mass fractions over registered species and a reaction list is ids, so both are things a host
 * resolves rather than things a record can assert. What this checks is the thermophysics, which is
 * the half a script author actually types and the half a typo silently ruins.
 */
const SUBSTANCE_SCHEMA: readonly Required[] = [
  { name: 'density', type: 'f32' },
  { name: 'heatCapacity', type: 'f32' },
  { name: 'conductivity', type: 'f32' },
  { name: 'emissivity', type: 'f32' },
  { name: 'porosity', type: 'f32' },
  { name: 'ignitionK', type: 'f32' },
  { name: 'criticalMassFlux', type: 'f32' },
];

const REACTION_SCHEMA: readonly Required[] = [
  { name: 'reactants', type: 'String' },
  { name: 'products', type: 'String' },
  { name: 'activationEnergy', type: 'f32' },
  { name: 'preExponential', type: 'f32' },
  { name: 'kind', type: 'String' },
];

const SCHEMAS: Readonly<Record<string, readonly Required[]>> = {
  substance: SUBSTANCE_SCHEMA,
  reaction: REACTION_SCHEMA,
};

/**
 * The written type as a script spells it, or `null` where the field left it to be inferred.
 *
 * `f32` and `String` both lex as `primitive`, and a host type would be `named`; an `Option` is
 * neither and is reported by its inner type, because a `density?` is still a density.
 */
function typeName(type: TypeRef | undefined): string | null {
  if (type === undefined) return null;
  if (type.kind === 'option') return typeName(type.inner);
  return type.name;
}

/**
 * A wider numeric type satisfies a narrower requirement, because the schema is about *kind* rather
 * than about width: a density written `f64` is a density.
 */
function satisfies(written: string, wanted: string): boolean {
  if (written === wanted) return true;
  if (wanted !== 'f32') return false;
  return written === 'f64';
}

export function checkChemistryAnnotations(
  decls: readonly Decl[],
  file: string,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (message: string, span: Span): void => {
    diagnostics.push({ code: 'DS0299', severity: 'error', message, file, start: span.start, end: span.end });
  };

  for (const decl of decls) {
    const annotations: readonly string[] =
      'annotations' in decl && Array.isArray(decl.annotations) ? (decl.annotations as string[]) : [];

    for (const annotation of Object.keys(SCHEMAS)) {
      if (!annotations.includes(annotation)) continue;
      if (decl.kind !== 'data') {
        report(
          `\`@${annotation}\` describes the shape of a \`data\` record and this is a ` +
            `\`${decl.kind}\`. There are no fields here to check.`,
          decl.span,
        );
        continue;
      }
      checkRecord(decl, annotation, SCHEMAS[annotation] as readonly Required[], report);
    }
  }
  return diagnostics;
}

function checkRecord(
  decl: DataDecl,
  annotation: string,
  schema: readonly Required[],
  report: (message: string, span: Span) => void,
): void {
  const byName = new Map<string, FieldDecl>();
  for (const field of decl.fields) byName.set(field.name, field);

  for (const required of schema) {
    const field = byName.get(required.name);
    if (field === undefined) {
      report(
        `\`@${annotation}\` record \`${decl.name}\` is missing \`${required.name}\`, which the ` +
          `registry requires. Add \`${required.name}: ${required.type}\`.`,
        decl.span,
      );
      continue;
    }
    const written = typeName(field.type);
    if (written !== null && !satisfies(written, required.type)) {
      report(
        `\`${decl.name}.${required.name}\` is \`${written}\`, and \`@${annotation}\` requires ` +
          `\`${required.type}\`.`,
        field.span,
      );
    }
  }
}

import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';

const compile = (source: string) =>
  compileDriftScript(source, { filename: 'a.drs', host: singleFileHost(), mode: 'development' });

const codes = (source: string): string[] => compile(source).diagnostics.map((d) => d.code);
const messages = (source: string): string =>
  compile(source).diagnostics.map((d) => d.message).join('\n');

const SUBSTANCE = `
@substance
data Dragonhide {
    density: f32 = 1100
    heatCapacity: f32 = 1600
    conductivity: f32 = 0.35
    emissivity: f32 = 0.94
    porosity: f32 = 0.20
    ignitionK: f32 = 1150degC
    criticalMassFlux: f32 = 0.012
}
`;

describe('@substance', () => {
  it('ACCEPTS A RECORD THAT CARRIES THE WHOLE SCHEMA', () => {
    /* `§20.7`'s worked example, verbatim. The annotation is an assertion the compiler checks, and
       this is it holding. */
    expect(codes(SUBSTANCE)).toEqual([]);
  });

  it('REFUSES A MISSING FIELD, naming it', () => {
    /*
     * The whole reason the annotation exists. A substance is forty numbers with no control flow and
     * nothing to infer, so what it needs is not a language form — it is a shape check, so a
     * misspelled field is a diagnostic here rather than a `NaN` in an exponent twenty ticks into a
     * burn. `@editor` is the precedent and `§20.7` is the argument.
     */
    const without = SUBSTANCE.replace('    emissivity: f32 = 0.94\n', '');
    expect(codes(without)).toContain('DS0299');
    expect(messages(without)).toContain('emissivity');
  });

  it('REFUSES A FIELD OF THE WRONG TYPE, naming what it wanted', () => {
    const wrong = SUBSTANCE.replace('density: f32 = 1100', 'density: String = "heavy"');
    expect(codes(wrong)).toContain('DS0299');
    expect(messages(wrong)).toContain('density');
    expect(messages(wrong)).toContain('f32');
  });

  it('allows extra fields, because a game knows things this schema does not', () => {
    /* The assertion is that every required field is *present*, not that no other one is. A substance
       carrying a `dropTable` is a game's business. */
    const extra = SUBSTANCE.replace('}', '    lootTier: i32 = 3\n}');
    expect(codes(extra)).toEqual([]);
  });

  it('refuses to sit on anything but a data record, naming what it found', () => {
    expect(codes('@substance\nfn nonsense() {\n}\n')).toContain('DS0299');
  });
});

const REACTION = `
@reaction
data BurnHide {
    reactants: String = "dragonhide:1,O2:14"
    products: String = "CO2:9,H2O(g):7"
    activationEnergy: f32 = 180kJ
    preExponential: f32 = 1000000000000
    kind: String = "combustion"
}
`;

describe('@reaction', () => {
  it('accepts a record that carries the whole schema', () => {
    expect(codes(REACTION)).toEqual([]);
  });

  it('refuses one that does not, naming the field', () => {
    const without = REACTION.replace('    kind: String = "combustion"\n', '');
    expect(codes(without)).toContain('DS0299');
    expect(messages(without)).toContain('kind');
  });

  it('DOES NOT CHECK THE ELEMENT BALANCE, and says where that check lives', () => {
    /*
     * **`§20.7` wanted this and it is refused, for a structural reason.** It says "the stoichiometry
     * is literals in the record, the formulas are in the registry" — and the registry is in
     * `@driftengine/chemistry`, which this package may not import and must not, since that
     * independence is asserted three ways. The compiler has the subscripts of nothing.
     *
     * **What is not lost** is the check: `ReactionRegistry.register` already refuses an unbalanced
     * reaction naming the element and the size of the gap. What is lost is the *timing* — init
     * rather than compile. This test pins that: a reaction whose carbon does not balance compiles
     * clean here, on purpose, and would be refused the moment a host registered it.
     */
    const unbalanced = REACTION.replace('"CO2:9,H2O(g):7"', '"CO2:2,H2O(g):7"');
    expect(codes(unbalanced)).toEqual([]);
  });
});

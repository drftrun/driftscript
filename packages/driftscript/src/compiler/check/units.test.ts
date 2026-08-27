import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';

const compile = (source: string) =>
  compileDriftScript(source, { filename: 'a.drs', host: singleFileHost(), mode: 'development' });

const codes = (source: string): string[] => compile(source).diagnostics.map((d) => d.code);

const js = (source: string): string => {
  const result = compile(source);
  expect(result.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`))
    .toEqual([]);
  return result.code;
};

describe('the chemistry unit suffixes', () => {
  it('ERASES EACH ONE INTO THE BASE UNIT, at the literal', () => {
    /*
     * The existing rule, applied to eleven more: a unit is a fact about the literal and nothing a
     * backend ever sees. Kilograms, joules, watts and pascals are already the base units the
     * engine's own APIs speak, so those convert by one and exist to be *read*, not converted.
     */
    const out = js(`
      @pure
      fn values() -> f32 {
        return 2kg + 3g + 250kJ + 1MJ + 5J + 40W + 101kPa + 200Pa + 1mol
      }
    `);
    expect(out).toContain('2');
    /* Grams are thousandths of the base unit, kilojoules are thousands of it. */
    expect(out).toContain('0.003');
    expect(out).toContain('250000');
    expect(out).toContain('1000000');
    expect(out).toContain('101000');
  });

  it('TURNS CELSIUS INTO KELVIN, which needs an offset and not a scale', () => {
    /*
     * The first unit in this language to need one. `20degC` is 293.15 K, and every other suffix so
     * far has been a multiplication — so `UNIT_SCALE` grew an offset for this one entry, rather than
     * `degC` being erased wrongly and quietly.
     */
    expect(js('@pure\nfn t() -> f32 { return 20degC }')).toContain('293.15');
    /* And kelvin is the base unit, so it converts by one and reads as itself. */
    expect(js('@pure\nfn t() -> f32 { return 300K }')).toContain('300');
  });

  it('REFUSES degC WHERE THE VALUE IS A DIFFERENCE, naming the position', () => {
    /*
     * **The trap `§20.6` is written about.** Celsius is an offset scale, so a *difference* of five
     * degrees written as `5degC` erases to 278.15 — wrong by 273.15, and wrong silently, which is
     * the worst kind of wrong a compiler can let through.
     *
     * A `+` or `-` is where a value is being combined rather than stated, and nothing the compiler
     * can see distinguishes "an absolute temperature being subtracted" from "a delta". So both are
     * refused and the diagnostic says to write the difference in `K` — which is numerically
     * identical, because a kelvin and a degree Celsius are the same size.
     */
    expect(codes('@pure\nfn t(a: f32) -> f32 { return a - 5degC }')).toContain('DS0298');
    expect(codes('@pure\nfn t(a: f32) -> f32 { return a + 5degC }')).toContain('DS0298');
    expect(codes('@pure\nfn t() -> f32 { return 20degC - 5degC }')).toContain('DS0298');
  });

  it('says what to write instead', () => {
    const message = compile('@pure\nfn t(a: f32) -> f32 { return a - 5degC }')
      .diagnostics.find((d) => d.code === 'DS0298')?.message ?? '';
    expect(message).toContain('K');
    expect(message).toContain('273.15');
  });

  it('ALLOWS degC EVERYWHERE IT IS AN ABSOLUTE TEMPERATURE', () => {
    /*
     * The refusal is narrow on purpose. A threshold, an argument and an assignment are all places a
     * Celsius reading is exactly what an author means, and refusing those would push everyone back
     * to writing 413.15 by hand — which is the readability this suffix exists to buy.
     */
    expect(codes('@pure\nfn hot(t: f32) -> bool { return t > 140degC }')).toEqual([]);
    expect(codes('@pure\nfn t() -> f32 { let x: f32 = 100degC\n  return x }')).toEqual([]);
  });

  it('keeps the old suffixes working, which is what longest-first ordering is for', () => {
    /* `ms` must still beat `m`, and now `mol` must beat both — and `MJ` must not be found inside a
       number that meant megajoules where `M` is not a unit at all. */
    expect(js('@pure\nfn t() -> f32 { return 250ms }')).toContain('0.25');
    expect(js('@pure\nfn t() -> f32 { return 30m }')).toContain('30');
    expect(js('@pure\nfn t() -> f32 { return 2mol }')).toContain('2');
  });
});

import { describe, expect, it } from 'vitest';
import { parse } from '../parser.ts';
import { check } from './checker.ts';

const diagnose = (source: string): { code: string; message: string }[] => {
  const parsed = parse(source, 'm.drs');
  const parseErrors = parsed.diagnostics.filter((d) => d.severity === 'error');
  if (parseErrors.length > 0) return parseErrors.map((d) => ({ code: d.code, message: d.message }));
  return check(parsed.module, 'm.drs')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => ({ code: d.code, message: d.message }));
};

describe('@editor is checked against the field it annotates', () => {
  it('accepts a range on a numeric field', () => {
    expect(
      diagnose(`
component Perception {
    @editor(label: "Sight Range", category: "Perception", range: 1m..150m)
    sightRange: f64 = 40m
}
`),
    ).toEqual([]);
  });

  it('accepts a range with no units on a field with no units', () => {
    expect(
      diagnose(`
component Health {
    @editor(range: 0..100)
    current: f64 = 50
}
`),
    ).toEqual([]);
  });

  it('refuses a range on a field that holds text', () => {
    const errors = diagnose(`
component Label {
    @editor(range: 1..10)
    text: String = ""
}
`);
    expect(errors[0]?.code).toBe('DS0292');
    expect(errors[0]?.message).toContain('numeric');
  });

  it('refuses a range whose bounds are the wrong way round', () => {
    const errors = diagnose(`
component Health {
    @editor(range: 100..0)
    current: f64 = 50
}
`);
    expect(errors[0]?.code).toBe('DS0292');
    expect(errors[0]?.message).toContain('wrong way round');
  });

  it('refuses a range in a different unit from the field it is on', () => {
    /* A slider in seconds over a field in metres moves the value by the wrong amount, and nothing
       at runtime can tell — the units are erased by then. */
    const errors = diagnose(`
component Perception {
    @editor(range: 1s..150s)
    sightRange: f64 = 40m
}
`);
    expect(errors[0]?.code).toBe('DS0293');
    expect(errors[0]?.message).toContain('40m'.slice(2));
  });

  it('refuses a range whose two bounds disagree with each other', () => {
    const errors = diagnose(`
component Perception {
    @editor(range: 1m..150s)
    sightRange: f64 = 40m
}
`);
    expect(errors[0]?.code).toBe('DS0136');
    expect(errors[0]?.message).toContain('different units');
  });

  it('accepts an assetType on a text field', () => {
    expect(
      diagnose(`
component Animated {
    @editor(assetType: "AnimationClip")
    idleClip: String = ""
}
`),
    ).toEqual([]);
  });

  it('refuses an assetType on a number', () => {
    const errors = diagnose(`
component Animated {
    @editor(assetType: "AnimationClip")
    idleClip: f64 = 0
}
`);
    expect(errors[0]?.code).toBe('DS0294');
  });

  it('refuses a key that is not one of the four, naming all four', () => {
    const errors = diagnose(`
component Perception {
    @editor(tooltip: "how far it sees")
    sightRange: f64 = 40
}
`);
    expect(errors[0]?.code).toBe('DS0136');
    expect(errors[0]?.message).toContain('assetType');
  });

  it('takes the keys in any order, because this is a description and not a signature', () => {
    expect(
      diagnose(`
component Perception {
    @editor(range: 1..150, category: "Perception", label: "Sight")
    sightRange: f64 = 40
}
`),
    ).toEqual([]);
  });

  it('still accepts `@id` beside `@editor`', () => {
    expect(
      diagnose(`
component Perception {
    @id("range")
    @editor(label: "Sight")
    sightRange: f64 = 40
}
`),
    ).toEqual([]);
  });

  it('refuses an annotation that is neither', () => {
    const errors = diagnose(`
component Perception {
    @hot
    sightRange: f64 = 40
}
`);
    expect(errors[0]?.code).toBe('DS0130');
    expect(errors[0]?.message).toContain('@editor');
  });
});

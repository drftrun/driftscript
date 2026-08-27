import { describe, expect, it } from 'vitest';
import { parse } from '../parser.ts';
import { check } from '../check/checker.ts';
import { lower } from './lower.ts';
import { compileDriftScript, singleFileHost } from '../index.ts';

const PULSE = `data PulseState {
    phase: f32 = 0
}

fn update(state: mut PulseState, dt: f32) {
    state.phase += dt
}
`;

const lowerSource = (source: string) => {
  const { module } = parse(source, 'a.drs');
  return lower(module, check(module, 'a.drs'));
};

describe('lowering', () => {
  /** The first statement of the pulse example's `update`, narrowed once for every test below. */
  const firstAssign = (source: string) => {
    const stmt = lowerSource(source).fns[0].body[0];
    if (stmt.kind !== 'assign') throw new Error(`expected an assign, got ${stmt.kind}`);
    return stmt;
  };

  it('carries a resolved type on every expression node', () => {
    const stmt = firstAssign(PULSE);
    expect(stmt.target.type).toEqual({ kind: 'f32' });
    expect(stmt.value.type).toEqual({ kind: 'f32' });
  });

  it('expands a compound assignment into a read and a write', () => {
    const stmt = firstAssign(PULSE);
    expect(stmt.value.kind).toBe('binary');
    if (stmt.value.kind !== 'binary') throw new Error('expected a binary expression');
    expect(stmt.value.op).toBe('+');
    expect(stmt.value.left).toMatchObject({ kind: 'field', name: 'phase' });
    expect(stmt.value.right).toMatchObject({ kind: 'local', name: 'dt' });
  });

  it('lowers a field default into an initialiser carrying its type', () => {
    const ir = lowerSource(PULSE);
    expect(ir.data[0].fields[0].init).toMatchObject({ kind: 'const', value: 0 });
    expect(ir.data[0].fields[0].init.type).toEqual({ kind: 'f32' });
  });

  it('supplies an initialiser for a field that declared no default', () => {
    const ir = lowerSource('data P {\n    a: f32\n    b: String\n    c: bool\n}\n');
    expect(ir.data[0].fields.map((f) => f.init)).toMatchObject([
      { kind: 'const', value: 0 },
      { kind: 'const', value: '' },
      { kind: 'const', value: false },
    ]);
  });

  it('collects the modules the source imported as requirements, in source order', () => {
    const ir = lowerSource(
      'import { play } from "drift/audio"\nimport { clamp } from "std/math"\n\ndata P {\n    a: f32 = 0\n}\n',
    );
    expect(ir.requires).toEqual(['drift/audio', 'std/math']);
  });

  it('lists a module imported twice only once', () => {
    const ir = lowerSource(
      'import { play } from "drift/audio"\nimport { stop } from "drift/audio"\n\ndata P {\n    a: f32 = 0\n}\n',
    );
    expect(ir.requires).toEqual(['drift/audio']);
  });

  it('erases a unit, converting to the base unit and leaving a bare number behind', () => {
    const ir = lowerSource('data P {\n    delay: f32 = 250ms\n}\n');
    const init = ir.data[0].fields[0].init;
    /* Seconds are the base unit, so 250ms is 0.25 — the same erasure `90deg` gets to radians.
       A literal that kept its 250 would mean a backend had to know what `ms` was. */
    expect(init).toMatchObject({ kind: 'const', value: 0.25 });
    expect(JSON.stringify(init)).not.toContain('unit');
    expect(JSON.stringify(init)).not.toContain('ms');
  });

  it('leaves a base-unit literal at its own value', () => {
    const ir = lowerSource('data P {\n    span: f32 = 30m\n    wait: f32 = 2s\n}\n');
    expect(ir.data[0].fields.map((f) => f.init)).toMatchObject([
      { kind: 'const', value: 30 },
      { kind: 'const', value: 2 },
    ]);
  });

  it('converts an angle at the literal, so radians reach the backend', () => {
    const ir = lowerSource('data P {\n    turn: f32 = 90deg\n}\n');
    const init = ir.data[0].fields[0].init;
    if (init.kind !== 'const') throw new Error('expected a constant');
    expect(init.value).toBeCloseTo(Math.PI / 2, 12);
  });

  it('keeps a span on every node, because source maps are built from these and not the tree', () => {
    const ir = lowerSource(PULSE);
    expect(ir.fns[0].span.end).toBeGreaterThan(ir.fns[0].span.start);
    expect(ir.fns[0].body[0].span.end).toBeGreaterThan(ir.fns[0].body[0].span.start);
    expect(ir.data[0].span.end).toBeGreaterThan(ir.data[0].span.start);
  });

  it('lowers nothing from a module the checker rejected', () => {
    const { module } = parse('data P {\n    a: f32 = "x"\n}\n', 'a.drs');
    const checked = check(module, 'a.drs');
    expect(checked.diagnostics.length).toBeGreaterThan(0);
    expect(() => lower(module, checked)).not.toThrow();
  });
});

describe('file imports are not capability requirements', () => {
  const ir = (source: string) => {
    const parsed = parse(source, 'w.drs');
    return lower(parsed.module, check(parsed.module, 'w.drs'));
  };

  it('keeps a file import out of requires, because the linker only reads capabilities', () => {
    const result = ir('import { Dog } from "./dog"\nimport { play } from "drift/audio"\n');
    expect(result.requires).toEqual(['drift/audio']);
    /* `values` is empty because nothing here was classified — `lower` was called without an imported
       scope, which is the unit-test path. What matters at this level is which side the specifier
       landed on. */
    expect(result.imports.map((i) => i.module)).toEqual(['./dog']);
  });

  it('deduplicates each side while keeping source order', () => {
    const result = ir(
      'import { Dog } from "./dog"\nimport { play } from "drift/audio"\n' +
        'import { Wolf } from "./dog"\nimport { stop } from "drift/audio"\n',
    );
    expect(result.requires).toEqual(['drift/audio']);
    expect(result.imports.map((i) => i.module)).toEqual(['./dog']);
  });

  it('carries the file imports out on the metadata, which is what a bundler watches', () => {
    const result = compileDriftScript('import { play } from "drift/audio"\n\ndata P {\n    a: f32 = 0\n}\n', {
      filename: 'w.drs',
      host: singleFileHost(),
      mode: 'development',
    });
    expect(result.metadata.imports).toEqual([]);
    expect(result.metadata.requires).toEqual(['drift/audio']);
  });
});

describe('prefab constants', () => {
  it('folds a negated literal so it reaches the prefab', () => {
  /*
   * A prefab keeps only constant values and drops the rest. Before the fold, `-0.55` lowered to a
   * unary node, so the field was dropped and the prefab carried **no rate at all** — the entity
   * span silently at zero, with nothing reported, because the value was well-formed and there was
   * no refusal for the checker to make. Found by the first script to put a negative number in one.
   */
  const ir = lowerSource(`
    component Spin { rate: f32 = 0 }
    prefab Hoop { Spin { rate: -0.55 } }
  `);
    const hoop = ir.prefabs.find((prefab) => prefab.name === 'Hoop');
    expect(hoop?.components[0]?.values['rate']).toBeCloseTo(-0.55, 6);
  });

  it('still keeps a positive one', () => {
    const ir = lowerSource(`
      component Spin { rate: f32 = 0 }
      prefab Relic { Spin { rate: 0.7 } }
    `);
    expect(ir.prefabs[0]?.components[0]?.values['rate']).toBeCloseTo(0.7, 6);
  });
});

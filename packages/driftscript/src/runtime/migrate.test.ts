import { describe, expect, it } from 'vitest';
import type { Schema } from './state.ts';
import { migrate } from './migrate.ts';

const schema = (name: string, fields: [string, string, string][]): Schema => ({
  name,
  fields: fields.map(([id, field, type]) => ({ id: `m::${name}::${id}`, name: field, type })),
});

const PULSE = schema('Pulse', [
  ['phase', 'phase', 'f32'],
  ['depth', 'depth', 'f32'],
]);

describe('migrating an instance', () => {
  it('keeps the value of every field that is still there', () => {
    const result = migrate({ phase: 3, depth: 2 }, PULSE, PULSE, { phase: 0, depth: 1 });

    expect(result).toEqual({ migrated: true, value: { phase: 3, depth: 2 } });
  });

  it('fills a new field from the constructor rather than from the schema', () => {
    /* A default may be computed, and the constructor is the only thing that can compute one. A
       schema carrying a value would be right for constants and silently wrong for the rest. */
    const grown = schema('Pulse', [
      ['phase', 'phase', 'f32'],
      ['depth', 'depth', 'f32'],
      ['amplitude', 'amplitude', 'f32'],
    ]);

    const result = migrate({ phase: 3, depth: 2 }, PULSE, grown, {
      phase: 0,
      depth: 1,
      amplitude: 7,
    });

    expect(result).toEqual({ migrated: true, value: { phase: 3, depth: 2, amplitude: 7 } });
  });

  it('drops a field the new shape does not have', () => {
    const shrunk = schema('Pulse', [['phase', 'phase', 'f32']]);
    const result = migrate({ phase: 3, depth: 2 }, PULSE, shrunk, { phase: 0 });

    expect(result).toEqual({ migrated: true, value: { phase: 3 } });
  });

  it('carries a value across a rename, because the id did not move', () => {
    const renamed = schema('Pulse', [
      ['phase', 'beat', 'f32'],
      ['depth', 'depth', 'f32'],
    ]);
    const result = migrate({ phase: 3, depth: 2 }, PULSE, renamed, { beat: 0, depth: 1 });

    expect(result).toEqual({ migrated: true, value: { beat: 3, depth: 2 } });
  });

  it('is unmoved by an insertion, because ids are not positions', () => {
    const inserted = schema('Pulse', [
      ['inserted', 'inserted', 'f32'],
      ['phase', 'phase', 'f32'],
      ['depth', 'depth', 'f32'],
    ]);
    const result = migrate({ phase: 3, depth: 2 }, PULSE, inserted, {
      inserted: 9,
      phase: 0,
      depth: 1,
    });

    expect(result).toEqual({ migrated: true, value: { inserted: 9, phase: 3, depth: 2 } });
  });

  it('refuses a type change, naming the field', () => {
    const retyped = schema('Pulse', [
      ['phase', 'phase', 'String'],
      ['depth', 'depth', 'f32'],
    ]);
    const result = migrate({ phase: 3, depth: 2 }, PULSE, retyped, { phase: '', depth: 1 });

    expect(result.migrated).toBe(false);
    if (result.migrated) throw new Error('expected a refusal');
    expect(result.reason).toContain('Pulse.phase');
    expect(result.reason).toContain('f32');
    expect(result.reason).toContain('String');
  });

  it('writes nothing at all when it refuses', () => {
    /* Every check runs before any write, so a refusal cannot leave an instance half-migrated —
       the same order `patchModule` compares shapes in, and for the same reason. */
    const retyped = schema('Pulse', [
      ['phase', 'phase', 'f32'],
      ['depth', 'depth', 'String'],
    ]);
    const instance = { phase: 3, depth: 2 };
    const result = migrate(instance, PULSE, retyped, { phase: 0, depth: '' });

    expect(result.migrated).toBe(false);
    expect(instance).toEqual({ phase: 3, depth: 2 });
  });

  it('does not mutate what it was given', () => {
    const instance = { phase: 3, depth: 2 };
    const grown = schema('Pulse', [
      ['phase', 'phase', 'f32'],
      ['depth', 'depth', 'f32'],
      ['amplitude', 'amplitude', 'f32'],
    ]);

    const result = migrate(instance, PULSE, grown, { phase: 0, depth: 1, amplitude: 7 });

    expect(instance).toEqual({ phase: 3, depth: 2 });
    if (!result.migrated) throw new Error('expected a migration');
    expect(result.value).not.toBe(instance);
  });

  it('composes: two steps equal one step through the same end shape', () => {
    const middle = schema('Pulse', [
      ['phase', 'phase', 'f32'],
      ['depth', 'depth', 'f32'],
      ['amplitude', 'amplitude', 'f32'],
    ]);
    const end = schema('Pulse', [
      ['phase', 'phase', 'f32'],
      ['amplitude', 'amplitude', 'f32'],
      ['offset', 'offset', 'f32'],
    ]);

    const first = migrate({ phase: 3, depth: 2 }, PULSE, middle, {
      phase: 0,
      depth: 1,
      amplitude: 7,
    });
    if (!first.migrated) throw new Error('expected a migration');
    const second = migrate(first.value, middle, end, { phase: 0, amplitude: 7, offset: 4 });

    const direct = migrate({ phase: 3, depth: 2 }, PULSE, end, {
      phase: 0,
      amplitude: 7,
      offset: 4,
    });

    expect(second).toEqual(direct);
  });

  it('refuses something that is not an instance at all', () => {
    expect(migrate(null, PULSE, PULSE, {}).migrated).toBe(false);
    expect(migrate(7, PULSE, PULSE, {}).migrated).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';
import { schemaOf } from './schema.ts';
import { typeKey } from './typeKey.ts';
import { parse } from '../parser.ts';
import { check } from '../check/checker.ts';
import { lower } from '../ir/lower.ts';
import type { Schema } from '../../runtime/state.ts';

const schemas = (source: string, module = 'm.drs'): Record<string, Schema> => {
  const parsed = parse(source, module);
  expect(parsed.diagnostics).toEqual([]);
  const checked = check(parsed.module, module);
  expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const ir = lower(parsed.module, checked, undefined, undefined, undefined, module);
  return Object.fromEntries(ir.data.map((d) => [d.name, schemaOf(d)]));
};

const idsOf = (source: string, record: string, module = 'm.drs'): Record<string, string> =>
  Object.fromEntries(schemas(source, module)[record].fields.map((f) => [f.name, f.id]));

describe('a field id', () => {
  it('does not move when a field is inserted before it', () => {
    /*
     * The failure this defends is silent. A positional id renumbers everything after an insertion,
     * so a save loads the right names with the wrong values — which looks exactly like working.
     */
    const before = idsOf('data Pulse {\n    phase: f32 = 0\n    depth: f32 = 1\n}\n', 'Pulse');
    const after = idsOf(
      'data Pulse {\n    inserted: f32 = 9\n    phase: f32 = 0\n    depth: f32 = 1\n}\n',
      'Pulse',
    );

    expect(after.phase).toBe(before.phase);
    expect(after.depth).toBe(before.depth);
  });

  it('does not move when the fields are simply reordered', () => {
    const one = idsOf('data Pulse {\n    phase: f32 = 0\n    depth: f32 = 1\n}\n', 'Pulse');
    const two = idsOf('data Pulse {\n    depth: f32 = 1\n    phase: f32 = 0\n}\n', 'Pulse');

    expect(two.phase).toBe(one.phase);
    expect(two.depth).toBe(one.depth);
  });

  it('survives a rename when the field pins the name it kept', () => {
    const before = idsOf('data Pulse {\n    phase: f32 = 0\n}\n', 'Pulse');
    const renamed = idsOf('data Pulse {\n    @id("phase")\n    beat: f32 = 0\n}\n', 'Pulse');

    expect(renamed.beat).toBe(before.phase);
  });

  it('moves on a rename that pins nothing, because only the author knows if it is the same thing', () => {
    const before = idsOf('data Pulse {\n    phase: f32 = 0\n}\n', 'Pulse');
    const renamed = idsOf('data Pulse {\n    beat: f32 = 0\n}\n', 'Pulse');

    expect(renamed.beat).not.toBe(before.phase);
  });

  it('differs between two records with the same fields, and both are stable', () => {
    /* Written out rather than inferred, because the failure it defends against is silent: two
       records sharing an id would migrate each other's values into each other's instances. */
    const both = schemas(
      'data Pulse {\n    phase: f32 = 0\n}\n\ndata Wave {\n    phase: f32 = 0\n}\n',
    );

    expect(both.Pulse.fields[0].id).not.toBe(both.Wave.fields[0].id);

    const reordered = schemas(
      'data Wave {\n    phase: f32 = 0\n}\n\ndata Pulse {\n    phase: f32 = 0\n}\n',
    );
    expect(reordered.Pulse.fields[0].id).toBe(both.Pulse.fields[0].id);
    expect(reordered.Wave.fields[0].id).toBe(both.Wave.fields[0].id);
  });

  it('differs between two modules declaring the same record', () => {
    const here = schemas('data Pulse {\n    phase: f32 = 0\n}\n', 'a.drs');
    const there = schemas('data Pulse {\n    phase: f32 = 0\n}\n', 'b.drs');

    expect(here.Pulse.fields[0].id).not.toBe(there.Pulse.fields[0].id);
  });

  it('refuses two fields that would share one id', () => {
    const { diagnostics } = parse(
      'data Pulse {\n    phase: f32 = 0\n    @id("phase")\n    beat: f32 = 0\n}\n',
      'm.drs',
    );
    expect(diagnostics).toEqual([]);

    const checked = check(
      parse('data Pulse {\n    phase: f32 = 0\n    @id("phase")\n    beat: f32 = 0\n}\n', 'm.drs')
        .module,
      'm.drs',
    );
    expect(checked.diagnostics.map((d) => d.code)).toContain('DS0284');
  });

  it('refuses an annotation a field does not take, rather than dropping it', () => {
    const { diagnostics } = parse('data Pulse {\n    @pure\n    phase: f32 = 0\n}\n', 'm.drs');
    expect(diagnostics.map((d) => d.code)).toContain('DS0130');
  });
});

describe('a field id under inheritance', () => {
  /** A two-file project: a base, and a subtype in another file. */
  const across = (base: string) => {
    const files: Record<string, string> = {
      '/wave.drs': base,
      '/pulse.drs': 'import { Wave } from "./wave"\n\ndata Pulse : Wave {\n    depth: f32 = 1\n}\n',
    };
    const { code, diagnostics } = compileDriftScript(files['/pulse.drs'], {
      filename: '/pulse.drs',
      mode: 'development',
      host: {
        resolve: (specifier, from) => {
          const dir = from.slice(0, from.lastIndexOf('/'));
          return `${dir}/${specifier.replace(/^\.\//, '')}.drs`;
        },
        load: (id) => files[id],
      },
    });
    expect(diagnostics).toEqual([]);

    const line = code.split('\n').find((l) => l.startsWith('export const __drift = ')) as string;
    const parsed = JSON.parse(line.slice('export const __drift = '.length).replace(/;$/, '')) as {
      schemas: Record<string, Schema>;
    };
    return Object.fromEntries(parsed.schemas.Pulse.fields.map((f) => [f.name, f.id]));
  };

  it('leaves a subtype own fields alone when the base grows', () => {
    /*
     * **This is what the whole design is for.** A positional id would shift every own-field of
     * every subtype in the project, in every file, from one edit in one file — and would do it
     * while looking like it worked. Here `depth` is unmoved and the new base field arrives with an
     * id belonging to the base.
     */
    const before = across('data Wave {\n    phase: f32 = 0\n}\n');
    const after = across('data Wave {\n    inserted: f32 = 9\n    phase: f32 = 0\n}\n');

    expect(after.depth).toBe(before.depth);
    expect(after.phase).toBe(before.phase);
  });

  it('keys an inherited field to the file that declared it, not to the file that inherits it', () => {
    const ids = across('data Wave {\n    phase: f32 = 0\n}\n');

    expect(ids.phase).toBe('/wave.drs::Wave::phase');
    expect(ids.depth).toBe('/pulse.drs::Pulse::depth');
  });
});

describe('the schema in the metadata', () => {
  it('rides on `__drift` and round-trips through JSON', () => {
    const { code, diagnostics } = compileDriftScript(
      'data Pulse {\n    phase: f32 = 0\n    depth: f32 = 1\n}\n',
      { filename: 'p.drs', host: singleFileHost(), mode: 'development' },
    );
    expect(diagnostics).toEqual([]);

    const line = code.split('\n').find((l) => l.startsWith('export const __drift = '));
    expect(line).toBeDefined();
    const parsed = JSON.parse(
      (line as string).slice('export const __drift = '.length).replace(/;$/, ''),
    ) as { schemas: Record<string, Schema> };

    expect(parsed.schemas.Pulse).toEqual({
      name: 'Pulse',
      fields: [
        { id: 'p.drs::Pulse::phase', name: 'phase', type: 'f32' },
        { id: 'p.drs::Pulse::depth', name: 'depth', type: 'f32' },
      ],
    });
  });
});

describe('a type key names the type and not its shape', () => {
  /*
   * **Every caller compares this string for equality**, so two types with one key are one type as
   * far as a migration and an interface hash are concerned. The option paragraph below records the
   * first time that went wrong; these are the rest of the same family, found while giving a task
   * frame a layout to compare.
   */
  it('gives every integer width its own key', () => {
    /*
     * This returned `type.kind`, so all eight keyed as `int`. Three consequences, and the third
     * left this repository: a migration would carry a `u8` into an `i64` and back, an interface
     * changing `fn set(v: u8)` to `fn set(v: i64)` hashed identically so no dependent recompiled,
     * and — because a component field's type is this string and a host's column table is keyed by
     * the width — **every integer component field threw at bind**, naming a type no script wrote.
     * Nothing in the corpus declared one, which is why it stood.
     */
    const keys = ['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64'].map((name) =>
      typeKey({ kind: 'int', name }),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(typeKey({ kind: 'int', name: 'u8' })).toBe('u8');
  });

  it('gives two enums different keys', () => {
    expect(typeKey({ kind: 'enum', name: 'Mood' })).not.toBe(typeKey({ kind: 'enum', name: 'Phase' }));
  });

  it('names what a list holds', () => {
    expect(typeKey({ kind: 'list', of: { kind: 'f32' } })).not.toBe(
      typeKey({ kind: 'list', of: { kind: 'string' } }),
    );
    expect(typeKey({ kind: 'list', of: { kind: 'f32' } })).toBe('list:f32');
  });

  it('names both halves of a result', () => {
    expect(
      typeKey({ kind: 'result', ok: { kind: 'f32' }, err: { kind: 'string' } }),
    ).not.toBe(typeKey({ kind: 'result', ok: { kind: 'string' }, err: { kind: 'f32' } }));
  });

  it('refuses a type it has no key for, rather than giving it a shared one', () => {
    /* The failure mode is the whole point: a default would make every unkeyed type equal to every
       other unkeyed type, which is how `int` came to mean eight widths at once. */
    expect(() => typeKey({ kind: 'somethingNew' } as never)).toThrow(/somethingNew/);
  });
});

describe('an option field names its inner type', () => {
  /*
   * A migration compares this key to decide whether a value may carry between two fields. While
   * every option keyed as `option`, a save could have carried a `String` into an `Entity` field —
   * a live-looking handle pointing at nothing, and no error anywhere.
   */
  it('gives two options of different inner types different keys', () => {
    expect(typeKey({ kind: 'option', inner: { kind: 'string' } })).not.toBe(
      typeKey({ kind: 'option', inner: { kind: 'f64' } }),
    );
  });

  it('names the inner type rather than only saying that there is one', () => {
    expect(typeKey({ kind: 'option', inner: { kind: 'f64' } })).toBe('option:f64');
  });

  it('recurses, so an option of an option is not an option of its inner type', () => {
    /* `T??` is legal and means an option of an option. A non-recursive version reads the outer
       kind only and calls those two the same. */
    expect(
      typeKey({ kind: 'option', inner: { kind: 'option', inner: { kind: 'f64' } } }),
    ).not.toBe(typeKey({ kind: 'option', inner: { kind: 'f64' } }));
  });

  it('names a record inside an option by that record', () => {
    expect(typeKey({ kind: 'option', inner: { kind: 'data', name: 'Pulse' } })).toBe(
      'option:data:Pulse',
    );
  });
});

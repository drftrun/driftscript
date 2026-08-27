import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';

const SOURCE = `
component Perception {
    @editor(label: "Sight Range", category: "Perception")
    sightRange: f64 = 40
}

component Hunger { value: f64 = 0 }

entity Animal {
    require Hunger
    var target: Entity?
}

prefab Guard {
    Hunger {}
    Perception { sightRange: 60 }
}

system Feeder {
    writes Hunger
    after Movement

    update at 1Hz {
        for a in query<Animal>() {
            a.Hunger.value = 1
        }
    }
}

system Movement {
    update { }
}
`;

const compile = (mode: 'development' | 'production', source = SOURCE): string => {
  const result = compileDriftScript(source, {
    filename: 'w.drs',
    mode,
    manifest: { name: 'test', provides: ['drift/ecs'] },
    host: singleFileHost(),
  });
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(errors.map((d) => `${d.code} ${d.message}`).join('\n'));
  }
  return result.code;
};

const metadataOf = (code: string): Record<string, unknown> => {
  const match = /export const __drift = (\{.*\});/s.exec(code);
  if (match === null) throw new Error('no __drift metadata');
  return JSON.parse(match[1] as string) as Record<string, unknown>;
};

describe('the metadata a host builds a world from', () => {
  it('carries a schema per component, with ids keyed to the declaring module', () => {
    const placement = metadataOf(compile('development'));
    const components = placement.components as { name: string; schema: { fields: { id: string }[] } }[];
    expect(components.map((c) => c.name)).toEqual(['Perception', 'Hunger', 'Animal']);
    expect(components[0]?.schema.fields[0]?.id).toBe('w.drs::Perception::sightRange');
  });

  it("carries an entity's own fields as a component like any other", () => {
    /* A host reading `components` finds every store it has to make, without knowing which form
       declared it — while `entityTypes` still says which component an entity owns. */
    const placement = metadataOf(compile('development'));
    const components = placement.components as { name: string }[];
    expect(components.map((c) => c.name)).toContain('Animal');
    const entities = placement.entityTypes as { name: string; requires: string[]; ownComponent: string }[];
    expect(entities[0]).toMatchObject({ name: 'Animal', requires: ['Hunger'], ownComponent: 'Animal' });
  });

  it('marks a host-asserted component so a host knows not to create it', () => {
    const placement = metadataOf(
      compile('development', 'component Transform from host {\n    x: f64\n}\n'),
    );
    expect((placement.components as { fromHost: boolean }[])[0]?.fromHost).toBe(true);
  });

  it('carries the inferred reads and writes, not what the author declared', () => {
    const placement = metadataOf(compile('development'));
    const systems = placement.systems as { name: string; reads: string[]; writes: string[] }[];
    const feeder = systems.find((s) => s.name === 'Feeder');
    expect(feeder?.writes).toEqual(['Hunger']);
    expect(feeder?.reads).toEqual(['Hunger']);
  });

  it('carries the stride a rate compiled to, and the ordering constraint', () => {
    const placement = metadataOf(compile('development'));
    const systems = placement.systems as { name: string; everyTicks: number; after: string[] }[];
    expect(systems.find((s) => s.name === 'Feeder')).toMatchObject({
      everyTicks: 60,
      after: ['Movement'],
    });
  });

  it('carries a prefab as components and constant values', () => {
    const placement = metadataOf(compile('development'));
    expect(placement.prefabs).toEqual([
      {
        name: 'Guard',
        components: [
          { name: 'Hunger', values: {} },
          { name: 'Perception', values: { sightRange: 60 } },
        ],
      },
    ]);
  });

  it('exports a function per system, taking its world as the one parameter', () => {
    /* Named `world` rather than a `$`-prefixed temporary, because a system body has to be able to
       say it: `ecs.destroy(world, e)` takes the world as an argument like every other capability. */
    expect(compile('development')).toContain('export function Feeder(world)');
  });

  it('carries editor metadata in development', () => {
    const placement = metadataOf(compile('development'));
    const components = placement.components as { name: string; editor?: Record<string, unknown> }[];
    expect(components[0]?.editor).toMatchObject({
      sightRange: { label: 'Sight Range', category: 'Perception' },
    });
  });

  it('carries none in production, and is otherwise the same module', () => {
    const production = compile('production');
    expect(production).not.toContain('Sight Range');
    /* Payload, never semantics: everything a program does is identical between the two. */
    const placement = metadataOf(production);
    expect((placement.components as { name: string }[]).map((c) => c.name)).toEqual([
      'Perception',
      'Hunger',
      'Animal',
    ]);
    expect(placement.systems).toEqual(metadataOf(compile('development')).systems);
    expect(production).toContain('export function Feeder(world)');
  });

  it('leaves the two modes identical apart from that metadata', () => {
    /* The property that makes stripping payload rather than semantics: strip the one key and the
       two builds are byte-identical. If that ever stops being true, `mode` has grown a second job
       and `IMPROVEMENTS.md`'s warning applies to it. */
    const placement = (code: string): Record<string, unknown> => {
      const parsed = JSON.parse(/export const __drift = (\{.*\});/s.exec(code)?.[1] ?? '{}');
      parsed.components = (parsed.components as Record<string, unknown>[]).map(
        ({ editor: _dropped, ...rest }) => rest,
      );
      return parsed as Record<string, unknown>;
    };
    const strip = (code: string): string => code.replace(/export const __drift = \{.*\};/s, '');

    /* The code either build runs is identical, and the metadata differs by exactly one key. */
    expect(strip(compile('development'))).toBe(strip(compile('production')));
    expect(placement(compile('development'))).toEqual(placement(compile('production')));
  });
});

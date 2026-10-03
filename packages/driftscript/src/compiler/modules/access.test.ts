/**
 * A system's component access, followed into the functions it calls from other files.
 *
 * Access was inferred from the module's own functions, so a call into another file contributed
 * nothing. A system that declared what an imported helper wrote got `DS0291` telling it the
 * declaration was unused, and a system that left it undeclared got no `DS0288` and metadata that
 * never mentioned the write, so the engine refused it when the system ran.
 */
import { describe, expect, it } from 'vitest';
import { compileDriftScript } from '../index.ts';
import type { ModuleHost } from './host.ts';

function mapHost(files: Record<string, string>): ModuleHost {
  return {
    resolve(specifier, from) {
      const parts = from.slice(0, from.lastIndexOf('/')).split('/');
      for (const segment of specifier.split('/')) {
        if (segment === '.') continue;
        else if (segment === '..') parts.pop();
        else parts.push(segment);
      }
      const id = `${parts.join('/')}.drs`;
      return files[id] === undefined ? null : id;
    },
    load: (id) => files[id] ?? null,
  };
}

const NEEDS = `component Hunger from host {
    value: f32 = 0
}

component Fed from host {
    meals: f32 = 0
}

// Writes through a handle, so nothing in the signature says so: only the body does.
fn feed(who: Entity) {
    who.Hunger.value = 0
    who.Fed.meals = who.Fed.meals + 1
}

// Calls the other, so its access is two calls deep from a system in another file.
fn mealtime(who: Entity) {
    feed(who)
}
`;

const compile = (main: string) => {
  const files = { '/game/needs.drs': NEEDS, '/game/main.drs': main };
  return compileDriftScript(main, {
    filename: '/game/main.drs',
    mode: 'development',
    host: mapHost(files),
  });
};

const codes = (result: ReturnType<typeof compile>) =>
  result.diagnostics.map((d) => `${d.code} ${d.message}`);

describe('component access across a file boundary', () => {
  it('counts what an imported function writes, so the declaration is not called unused', () => {
    const result = compile(`import { mealtime } from "./needs"

component Hunger from host {
    value: f32 = 0
}

component Fed from host {
    meals: f32 = 0
}

system Dinner {
    writes Hunger
    writes Fed

    update {
        for e in query<Hunger>() {
            mealtime(e)
        }
    }
}
`);
    expect(codes(result).filter((c) => c.startsWith('DS0291'))).toEqual([]);
    expect(codes(result).filter((c) => c.startsWith('DS0288'))).toEqual([]);
  });

  it('refuses a write an imported function makes that the system did not declare', () => {
    const result = compile(`import { mealtime } from "./needs"

component Hunger from host {
    value: f32 = 0
}

component Fed from host {
    meals: f32 = 0
}

system Dinner {
    writes Hunger

    update {
        for e in query<Hunger>() {
            mealtime(e)
        }
    }
}
`);
    /* `feed` reads `Fed` as well as writing it, so both halves are undeclared, and nothing else. */
    const refused = codes(result).filter((c) => c.startsWith('DS0288'));
    expect(refused.some((c) => c.includes('writes `Fed`'))).toBe(true);
    expect(refused.every((c) => c.includes('`Fed`'))).toBe(true);
  });

  it('describes an undeclared system to the host with what its imported calls touch', () => {
    const result = compile(`import { mealtime } from "./needs"

component Hunger from host {
    value: f32 = 0
}

component Fed from host {
    meals: f32 = 0
}

system Dinner {
    update {
        for e in query<Hunger>() {
            mealtime(e)
        }
    }
}
`);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    /* The host builds its schedule from `__drift.systems`, so that is where the write has to be. */
    const drift = /export const __drift = (\{.*\});/.exec(result.code)?.[1] ?? '{}';
    const systems = (JSON.parse(drift) as { systems: { name: string; writes: string[] }[] }).systems;
    const dinner = systems.find((s) => s.name === 'Dinner');
    expect([...(dinner?.writes ?? [])].sort()).toEqual(['Fed', 'Hunger']);
  });
});

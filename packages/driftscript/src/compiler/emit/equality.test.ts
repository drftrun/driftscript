/**
 * `==` and `!=` compare what a value says, not which object holds it.
 *
 * An enum variant, an option, a result, a record and a list are all objects in the emitted
 * JavaScript, and `==` used to be JavaScript's own, which compares objects by identity. So two
 * `Shape.Circle(2)` were unequal, and worse, a variant stopped equalling itself across a hot reload:
 * the live record kept the old module's `Phase.Playing` and the new module compared it against its
 * own. A rule written `if round.phase != Phase.Playing { return }` returned forever after the first
 * save. A host's opaque value has no contents a script can see, so it still compares by identity.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '../parser.ts';
import { check } from '../check/checker.ts';
import { lower } from '../ir/lower.ts';
import { createRegistry, defineCapability } from '../../registry/capability.ts';
import { loadModule } from '../../runtime/module.ts';
import { patchModule } from '../../runtime/hot.ts';
import { emitJs } from './js.ts';

const emit = (source: string, filename = 'equal.drs') => {
  const { module } = parse(source, filename);
  const checked = check(module, filename);
  expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return emitJs(lower(module, checked), { filename, source }).code;
};

const importGenerated = (code: string) =>
  import(/* @vite-ignore */ `data:text/javascript;base64,${btoa(code)}`);

const ROUND = `enum Phase {
    Playing
    Won
    Lost
}

data Round {
    remaining: f32 = 60
    phase: Phase = Phase.Playing
}

fn tick(round: mut Round, dt: f32) {
    if round.phase != Phase.Playing {
        return
    }
    round.remaining = round.remaining - dt
}
`;

describe('equality', () => {
  it('holds for a variant kept across a hot reload', async () => {
    const code = emit(ROUND);
    const module = loadModule(await importGenerated(code));
    const round = (module.exports.createRound as () => { remaining: number })();
    /* A second import of the same code is a second module instance, as a save makes one. */
    patchModule(module, await importGenerated(`${code}\n// saved`), { Round: [round] });
    (module.exports.tick as (r: unknown, dt: number) => void)(round, 1);
    expect(round.remaining).toBe(59);
  });

  it('holds for a variant rebuilt from saved data', async () => {
    const mod = await importGenerated(emit(ROUND));
    const round = { remaining: 60, phase: JSON.parse('{"tag":"Playing"}') };
    mod.tick(round, 1);
    expect(round.remaining).toBe(59);
  });

  it('compares a variant with a payload by its payload', async () => {
    const mod = await importGenerated(
      emit(`enum Shape {
    Dot
    Circle(f32)
}

fn same(a: f32, b: f32) -> bool {
    return Shape.Circle(a) == Shape.Circle(b)
}

fn differ(a: f32) -> bool {
    return Shape.Circle(a) != Shape.Dot
}
`),
    );
    expect(mod.same(2, 2)).toBe(true);
    expect(mod.same(2, 3)).toBe(false);
    expect(mod.differ(2)).toBe(true);
  });

  it('compares records, options and lists by what they hold', async () => {
    const mod = await importGenerated(
      emit(`data Door {
    open: bool = false
    angle: f32 = 0
}

fn doors(a: f32, b: f32) -> bool {
    return Door { open: true, angle: a } == Door { open: true, angle: b }
}

fn options(a: f32, b: f32) -> bool {
    return some(a) == some(b)
}

fn absent(a: f32) -> bool {
    let nothing: f32? = none
    return some(a) != nothing
}

fn lists(a: f32, b: f32) -> bool {
    return [1, a] == [1, b]
}
`),
    );
    expect(mod.doors(90, 90)).toBe(true);
    expect(mod.doors(90, 45)).toBe(false);
    expect(mod.options(1, 1)).toBe(true);
    expect(mod.options(1, 2)).toBe(false);
    expect(mod.absent(1)).toBe(true);
    expect(mod.lists(2, 2)).toBe(true);
    expect(mod.lists(2, 3)).toBe(false);
  });

  it('compares a host value by identity, since a script cannot see inside one', async () => {
    const registry = createRegistry();
    registry.addType({ module: 'drift/test', name: 'Lamp', doc: 'A lamp the host owns.' });
    registry.add(
      defineCapability({
        module: 'drift/test',
        name: 'lit',
        signature: 'fn(lamp: Lamp) -> bool',
        params: [{ name: 'lamp', type: 'Lamp' }],
        returns: 'bool',
        effects: ['scene.read'],
        deterministic: true,
        doc: 'Whether a lamp is on.',
        implementation: 'drift/test.lit',
      }),
    );
    const source = `import { lit } from "drift/test"

fn same(a: Lamp, b: Lamp) -> bool {
    return a == b
}
`;
    const { module } = parse(source, 'lamp.drs');
    const checked = check(module, 'lamp.drs', registry);
    expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const code = emitJs(lower(module, checked), { filename: 'lamp.drs', source }).code;
    expect(code).not.toContain('$eq(');
    const mod = await importGenerated(code.replace(/^import .*$/m, ''));
    const one = { on: true };
    expect(mod.same(one, one)).toBe(true);
    expect(mod.same(one, { on: true })).toBe(false);
  });

  it('leaves numbers, strings and booleans to the comparison JavaScript already has', () => {
    const code = emit(`fn same(a: f32, b: f32, c: String, d: String) -> bool {
    return a == b && c == d
}
`);
    expect(code).not.toContain('$eq(');
  });
});

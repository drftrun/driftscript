import { describe, expect, it } from 'vitest';
import { parse } from '../parser.ts';
import { check } from '../check/checker.ts';
import { lower } from './lower.ts';
import type { IrStmt } from './ir.ts';

/** The first query loop in the first declaration, lowered through the real pipeline. */
const loopIn = (source: string): Extract<IrStmt, { kind: 'forQuery' }> => {
  const parsed = parse(source, 'm.drs');
  expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const checked = check(parsed.module, 'm.drs');
  expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const ir = lower(parsed.module, checked);
  /* Every function, not the first — a source with a helper in it declares the helper first, and
     taking `fns[0]` looked for a loop in the one function that never has one. */
  for (const fn of ir.fns) {
    const found = fn.body.find((stmt) => stmt.kind === 'forQuery');
    if (found?.kind === 'forQuery') return found;
  }
  throw new Error('no query loop was lowered');
};

describe('a query loop lowers with its plan resolved', () => {
  it('resolves each view to read or write from what the body does', () => {
    const loop = loopIn(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger, Health>() {
        e.Hunger.value = e.Health.current
    }
}
`);
    expect(loop.views).toEqual([
      { component: 'Hunger', forWriting: true },
      { component: 'Health', forWriting: false },
    ]);
  });

  it('takes a writable view when the write happens inside a helper', () => {
    /* The view decides which of the engine's two declaration checks the generated code faces, so a
       write a call away has to reach it — a direct-only answer would ask for a readable view and
       the engine would refuse the write at runtime. */
    const loop = loopIn(`
component Hunger { value: f64 = 0 }

fn bump(world: World, e: Entity) {
    e.Hunger.value = 1
}

fn f(world: World) {
    for e in query<Hunger>() {
        bump(world, e)
    }
}
`);
    expect(loop.views).toEqual([{ component: 'Hunger', forWriting: true }]);
  });

  it('takes no view of a component the body never touches', () => {
    /* A loop narrowing by four components and reading one takes one view. Asking for the other
       three would make a read-only system demand access the engine refuses. */
    const loop = loopIn(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger, Health>() {
        e.Hunger.value = 1
    }
}
`);
    expect(loop.views).toEqual([{ component: 'Hunger', forWriting: true }]);
    expect(loop.required).toEqual(['Hunger', 'Health']);
  });

  it('expands an entity term before the IR sees it', () => {
    const loop = loopIn(`
component Transform { x: f64 = 0 }
component Hunger { value: f64 = 0 }

entity Animal {
    require Transform
    var target: Entity?
}

fn f(world: World) {
    for a in query<Animal, Hunger>() {
        a.Transform.x = 1
    }
}
`);
    /* Four stores, not three: the entity's own `var` fields are a component too. */
    expect(loop.required).toEqual(['Transform', 'Animal', 'Hunger']);
    expect(loop.views).toEqual([{ component: 'Transform', forWriting: true }]);
  });

  it('carries the excluded set separately from the required one', () => {
    const loop = loopIn(`
component Hunger { value: f64 = 0 }
component Dead { at: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger>().without<Dead>() {
        e.Hunger.value = 1
    }
}
`);
    expect(loop.required).toEqual(['Hunger']);
    expect(loop.excluded).toEqual(['Dead']);
  });

  it('counts a `.with<T>()` term as required but yields no view unless the body touches it', () => {
    const loop = loopIn(`
component Hunger { value: f64 = 0 }
component Threat { level: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger>().with<Threat>() {
        e.Hunger.value = 1
    }
}
`);
    expect(loop.required).toEqual(['Hunger', 'Threat']);
    expect(loop.views).toEqual([{ component: 'Hunger', forWriting: true }]);
  });
});

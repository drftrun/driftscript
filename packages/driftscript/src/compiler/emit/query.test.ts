import { describe, expect, it } from 'vitest';
import { parse } from '../parser.ts';
import { check } from '../check/checker.ts';
import { lower } from '../ir/lower.ts';
import { emitJs } from './js.ts';

const emit = (source: string): string => {
  const { module, diagnostics } = parse(source, 'q.drs');
  expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const checked = check(module, 'q.drs');
  expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return emitJs(lower(module, checked), { filename: 'q.drs', source }).code;
};

const LOOP = `
component Hunger { value: f64 = 0 }

fn feed(world: World) {
    for e in query<Hunger>() {
        e.Hunger.value = 1
    }
}
`;

describe('a query loop emits a hoisted view and no host call per field', () => {
  it('opens a cursor, takes a view, and walks until a negative', () => {
    const code = emit(LOOP);
    expect(code).toContain('ecs.query(world, "Hunger")');
    expect(code).toContain('ecs.view(world, "Hunger", true)');
    expect(code).toContain('ecs.next(');
    expect(code).toMatch(/if \(e < 0\) break;/);
  });

  it('reads a field as a property load and an index, not a host call', () => {
    /* The whole point of decision 2. A call per field per entity per frame is what this replaces. */
    const code = emit(LOOP);
    expect(code).toMatch(/\$v0_0\.value\[\$i0_0\] = 1/);
    expect(code).not.toMatch(/ecs\.write\(/);
    expect(code).not.toMatch(/ecs\.read\(/);
  });

  it('indexes through the view every iteration rather than hoisting its arrays', () => {
    /*
     * **The staleness the view exists to prevent.** A column grows by reallocation and `add` is
     * immediate inside a system, so a walk that adds a component grows the array it is walking.
     * `const $c = $v0_0.value` before the loop would be storage nothing reads — no error, no wrong
     * type, just a value that never arrives. The generated body must go through the view.
     */
    const code = emit(LOOP);
    expect(code).toContain('$v0_0.sparse[');
    expect(code).not.toMatch(/const \$c\w* = \$v0_0\.\w+;/);
  });

  it('takes the entity index arithmetically, because generated code imports nothing', () => {
    expect(emit(LOOP)).toContain('% 67108864');
  });

  it('takes a readable view when the body only reads', () => {
    const code = emit(`
component Hunger { value: f64 = 0 }

fn look(world: World) -> f64 {
    var total: f64 = 0
    for e in query<Hunger>() {
        total += e.Hunger.value
    }
    return total
}
`);
    expect(code).toContain('ecs.view(world, "Hunger", false)');
  });

  it('excludes through the cursor rather than through the open call', () => {
    const code = emit(`
component Hunger { value: f64 = 0 }
component Dead { at: f64 = 0 }

fn feed(world: World) {
    for e in query<Hunger>().without<Dead>() {
        e.Hunger.value = 1
    }
}
`);
    expect(code).toContain('ecs.query(world, "Hunger")');
    expect(code).toContain('ecs.without($q0, "Dead")');
  });

  it('numbers temporaries by depth, so a nested query does not collide with its parent', () => {
    const code = emit(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn feed(world: World) {
    for a in query<Hunger>() {
        for b in query<Health>() {
            a.Hunger.value = b.Health.current
        }
    }
}
`);
    expect(code).toContain('$q0');
    expect(code).toContain('$q1');
    expect(code).toContain('$v1_0');
  });

  it('points a nested loop\'s field access at its own view, not its parent\'s', () => {
    /*
     * **The case that caught two depth counters.** The emitter kept one and the lowering another,
     * so perturbing either left the other untouched: the declarations still read `$v1_0` while a
     * `componentField` inside the inner loop pointed at `$v0_0`. Asserting the *body* rather than
     * the declarations is what separates them.
     */
    const code = emit(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn feed(world: World) {
    for a in query<Hunger>() {
        for b in query<Health>() {
            a.Hunger.value = b.Health.current
        }
    }
}
`);
    expect(code).toMatch(/\$v0_0\.value\[\$i0_0\] = \$v1_0\.current\[\$i1_0\]/);
  });

  it('requires drift/ecs even though the file imports nothing from it', () => {
    /* The form is a use of the capability, so the module has the requirement — and the linker
       refusing it against a target with no entity model is the intended behaviour. */
    const code = emit(LOOP);
    expect(code).toContain('"requires":["drift/ecs"]');
    expect(code).toContain('export function __bind($host)');
    expect(code).toContain('$host["drift/ecs"]');
  });
});

describe('two query loops side by side', () => {
  /*
   * **Sibling loops share a nesting depth, and the temporaries are named by depth.** So a function
   * with two loops one after the other emitted `const $q0` twice in one block, and the generated
   * module threw `Identifier '$q0' has already been declared` at load — a `SyntaxError` from
   * generated code, which is the worst kind of compiler bug because the source it names is not the
   * source anybody wrote.
   *
   * Found by a system that advances a shared clock in one loop and reads it in the next, which is
   * the ordinary shape for "one entity holds the time and many entities sample it".
   *
   * The fix is a block around each loop rather than a counter beside the depth: the depth is what
   * a `componentField` names, and a second count is exactly what the nested-loop test above
   * already caught once.
   */
  it('does not redeclare the cursor', () => {
    const code = emit(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn tick(world: World) {
    for a in query<Hunger>() {
        a.Hunger.value = 1
    }
    for b in query<Health>() {
        b.Health.current = 2
    }
}
`);
    /* Both loops are at depth 0, so both name `$q0` — and each must be in its own scope. */
    expect(code.match(/const \$q0 = /g)).toHaveLength(2);
    /* Which is what makes it legal JavaScript. */
    expect(() => new Function(code.replace(/^export /gm, ''))).not.toThrow();
  });

  it('still nests, so an inner loop reaches its own view', () => {
    const code = emit(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn tick(world: World) {
    for a in query<Hunger>() {
        for b in query<Health>() {
            a.Hunger.value = b.Health.current
        }
    }
}
`);
    expect(() => new Function(code.replace(/^export /gm, ''))).not.toThrow();
    expect(code).toContain('$q1');
  });
});

/**
 * A host that pools cursors, so that not giving one back is observable.
 *
 * This is the whole reason a `break` out of a query loop drains: the protocol generated code speaks
 * has `query`, `without`, `view` and `next` and **no release call**, so a cursor returns to the pool
 * when `next` reports exhaustion and by no other route. A loop that simply left would keep it, and a
 * system doing that once a frame would run the pool dry — with no error, until queries started
 * failing for a reason nowhere near the code that caused it.
 *
 * Modelled rather than mocked: `leased` counts what has gone out and not come back, which is the
 * quantity a real pool would exhaust.
 */
const pooledEcs = (entities: readonly number[]) => {
  let leased = 0;
  const columns = { sparse: [] as number[], value: [] as number[] };
  entities.forEach((entity, index) => {
    columns.sparse[entity % 67108864] = index;
    columns.value[index] = 0;
  });
  return {
    leased: () => leased,
    host: {
      query: () => {
        leased += 1;
        return { at: 0, spent: false };
      },
      without: () => undefined,
      view: () => columns,
      next: (cursor: { at: number; spent: boolean }) => {
        if (cursor.at >= entities.length) {
          /* Exhaustion is what returns the cursor, and it is idempotent: draining a cursor that is
             already spent must not hand a second one back to the pool. */
          if (!cursor.spent) {
            cursor.spent = true;
            leased -= 1;
          }
          return -1;
        }
        const entity = entities[cursor.at];
        cursor.at += 1;
        return entity;
      },
    },
    columns,
  };
};

const run = async (source: string, entities: readonly number[]) => {
  const code = emit(source);
  const namespace = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${btoa(code)}`
  )) as Record<string, unknown> & { __bind: (host: Record<string, unknown>) => void };
  const ecs = pooledEcs(entities);
  namespace.__bind({ 'drift/ecs': ecs.host });
  return { namespace, ecs };
};

describe('leaving a query loop early', () => {
  const BREAKS = `
component Hunger { value: f64 = 0 }

fn feed(world: World) {
    for e in query<Hunger>() {
        e.Hunger.value = 1
        break
    }
}
`;

  it('gives the cursor back, which only exhaustion does', async () => {
    const { namespace, ecs } = await run(BREAKS, [10, 11, 12]);
    (namespace.feed as (world: unknown) => void)({});
    expect(ecs.leased()).toBe(0);
  });

  it('still stops at the first entity, so the drain is not a walk of the body', async () => {
    const { namespace, ecs } = await run(BREAKS, [10, 11, 12]);
    (namespace.feed as (world: unknown) => void)({});
    /* One write, three entities. The remainder is walked by `next` alone and the body never runs
       for it — which is what makes `break` still mean "stop", at the cost of a call per entity. */
    expect(ecs.columns.value).toEqual([1, 0, 0]);
  });

  it('needs no drain for `continue`, which reaches exhaustion the ordinary way', async () => {
    const code = emit(`
component Hunger { value: f64 = 0 }

fn feed(world: World) {
    for e in query<Hunger>() {
        if e.Hunger.value > 0 {
            continue
        }
        e.Hunger.value = 1
    }
}
`);
    /* One drain would be one too many: the loop is going to exhaust the cursor by itself. */
    expect(code).not.toContain('while (ecs.next($q0) >= 0);');
    expect(code).toContain('continue;');
  });

  it('drains the loop it is leaving, not one it is nested in', async () => {
    const code = emit(`
component Hunger { value: f64 = 0 }

fn feed(world: World) {
    for e in query<Hunger>() {
        var n = 0
        while n < 3 {
            n += 1
            break
        }
        e.Hunger.value = 1
    }
}
`);
    /* The `break` belongs to the `while`, so nothing is drained: draining here would abandon the
       query loop's remaining entities on the first turn of an inner loop. */
    expect(code).not.toContain('while (ecs.next($q0) >= 0);');
  });
});

describe('a component write inside a query loop', () => {
  it('goes through the view, not through `ecs.write`', () => {
    /*
     * **A regression guard, and it caught one within a minute of being needed.**
     *
     * Component access outside a query loop lowers to `ecs.read`/`ecs.write`, and the checker
     * records the world for *every* access — including loop-bound ones, because a row handed to a
     * function needs its world at the call site. The write path then took the `ecs` route for a
     * loop-bound target too: a host call per field per entity per frame, which is the entire cost
     * the view exists to remove, and nothing about the program's behaviour would have looked wrong.
     */
    const code = emit(LOOP);
    expect(code).toMatch(/\$v0_0\.value\[\$i0_0\] = 1/);
    expect(code).not.toContain('ecs.write(');
  });
});


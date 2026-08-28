import { describe, expect, it } from 'vitest';
import { parse } from '../parser.ts';
import { check } from './checker.ts';
import { collectEntityModel, inferAccess } from './entities.ts';
import { createRegistry, defineCapability } from '../../registry/capability.ts';

/** Parse and check a source, returning only the errors a reader would see. */
const allIn = (source: string): { code: string; severity: string; message: string }[] => {
  const parsed = parse(source, 'm.drs');
  const parseErrors = parsed.diagnostics.filter((d) => d.severity === 'error');
  if (parseErrors.length > 0) {
    return parseErrors.map((d) => ({ code: d.code, severity: d.severity, message: d.message }));
  }
  return check(parsed.module, 'm.drs').diagnostics.map((d) => ({
    code: d.code,
    severity: d.severity,
    message: d.message,
  }));
};

const errorsIn = (source: string): { code: string; message: string }[] => {
  const parsed = parse(source, 'm.drs');
  const parseErrors = parsed.diagnostics.filter((d) => d.severity === 'error');
  if (parseErrors.length > 0) {
    return parseErrors.map((d) => ({ code: d.code, message: d.message }));
  }
  return check(parsed.module, 'm.drs')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => ({ code: d.code, message: d.message }));
};

describe('component and entity resolution', () => {
  it('types a field read and written through a query binding', () => {
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger>() {
        e.Hunger.value = 1
    }
}
`),
    ).toEqual([]);
  });

  it('refuses a component the loop did not require', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger>() {
        e.Health.current = 1
    }
}
`);
    expect(errors[0]?.code).toBe('DS0285');
    expect(errors[0]?.message).toContain('Health');
  });

  it('lets `.with<T>()` make a component readable without yielding it', () => {
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger>().with<Health>() {
        e.Health.current = 1
    }
}
`),
    ).toEqual([]);
  });

  it('refuses reading a component the loop excluded', () => {
    /* An entity a `without` matched is not in the result, so a read through one would be a read of
       a component the loop proved absent. */
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }
component Dead { at: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger>().without<Dead>() {
        e.Dead.at = 1
    }
}
`);
    expect(errors[0]?.code).toBe('DS0285');
  });

  it('refuses an unknown field on a known component', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger>() {
        e.Hunger.missing = 1
    }
}
`);
    expect(errors[0]?.code).toBe('DS0203');
    expect(errors[0]?.message).toContain('missing');
  });

  it('refuses a query term that is neither a component nor an entity', () => {
    const errors = errorsIn(`
fn f(world: World) {
    for e in query<Nothing>() {
    }
}
`);
    expect(errors[0]?.code).toBe('DS0286');
    expect(errors[0]?.message).toContain('Nothing');
  });

  it('expands an entity term to its requires and its own component', () => {
    expect(
      errorsIn(`
component Transform { x: f64 = 0 }
component Hunger { value: f64 = 0 }

entity Animal {
    require Transform
    var target: f64?
}

fn f(world: World) {
    for a in query<Animal, Hunger>() {
        a.Transform.x = 1
        a.Hunger.value = 2
        let seen = a.Animal.target
    }
}
`),
    ).toEqual([]);
  });

  it('will not put a bare value in an optional field, exactly as a record would not', () => {
    /* An entity's own fields are ordinary fields. `f64?` takes an option, and this language has no
       implicit wrapping — which is the behaviour that caught a wrong assertion in this file. */
    const errors = errorsIn(`
entity Animal {
    var target: f64?
}

fn f(world: World) {
    for a in query<Animal>() {
        a.Animal.target = 3
    }
}
`);
    expect(errors[0]?.code).toBe('DS0208');
  });

  it('refuses assigning to the loop binding itself', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger>() {
        for other in query<Hunger>() {
            e = other
        }
    }
}
`);
    expect(errors[0]?.code).toBe('DS0285');
    expect(errors[0]?.message).toContain('does not');
  });

  it('declares no component for an entity with no var fields', () => {
    const errors = errorsIn(`
component Transform { x: f64 = 0 }

entity Moving {
    require Transform
}

fn f(world: World) {
    for m in query<Moving>() {
        m.Moving.anything = 1
    }
}
`);
    /* Not "did not require" — there is no such component at all. An empty implicit component would
       be a marker the author never asked for. */
    expect(errors[0]?.code).toBe('DS0286');
  });

  it('takes `Entity` as a field type, which is the design\'s own first example', () => {
    expect(
      errorsIn(`
component Transform { x: f64 = 0 }

entity Animal {
    require Transform
    var target: Entity?
}

fn f(world: World) {
    for a in query<Animal>() {
        let seen = a.Animal.target
    }
}
`),
    ).toEqual([]);
  });

  it('takes `Entity` as a parameter type, so a helper can be handed a handle', () => {
    /*
     * Without a writable name for the type there is no helper that can touch a component, and
     * propagating component access through the call graph would have nothing to propagate.
     *
     * **The helper takes a `World` as of 1.6.0, and it had to.** A handle no query loop bound
     * reaches its components through `drift/ecs`, so there has to be a world to reach them from.
     * Before this the body compiled to `e.Hunger.value = 1` — a property assignment on a number,
     * which type-checked, linked, and threw the moment it ran. The inference this test is about was
     * always right; the code under it was not.
     */
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }

fn bump(world: World, e: Entity) {
    e.Hunger.value = 1
}

fn f(world: World) {
    for e in query<Hunger>() {
        bump(world, e)
    }
}
`),
    ).toEqual([]);
  });

  it('will not take an f64 where a handle is wanted', () => {
    const errors = errorsIn(`
fn bump(e: Entity) {
}

fn f(world: World) {
    bump(1)
}
`);
    expect(errors[0]?.code).toBe('DS0263');
  });

  it('refuses a component and a record sharing a name', () => {
    const errors = errorsIn(`
data Health { current: f64 = 0 }
component Health { current: f64 = 0 }
`);
    expect(errors[0]?.code).toBe('DS0287');
    expect(errors[0]?.message).toContain('record');
  });

  it('refuses two components of one name', () => {
    const errors = errorsIn(`
component Health { current: f64 = 0 }
component Health { maximum: f64 = 0 }
`);
    expect(errors[0]?.code).toBe('DS0287');
  });

  it('takes a component declared after the loop that uses it', () => {
    /* Every other declaration in this language may be used before it is written, and a query term
       is not the place to invent an exception. */
    expect(
      errorsIn(`
fn f(world: World) {
    for e in query<Hunger>() {
        e.Hunger.value = 1
    }
}

component Hunger { value: f64 = 0 }
`),
    ).toEqual([]);
  });

  it('types a host-asserted component exactly like a declared one', () => {
    expect(
      errorsIn(`
component Transform from host { x: f64 }

fn f(world: World) {
    for e in query<Transform>() {
        e.Transform.x = 1
    }
}
`),
    ).toEqual([]);
  });

  it('lets a handle cross into an f64 but not the other way', () => {
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }

fn takes(handle: f64) -> f64 {
    return handle
}

fn f(world: World) {
    for e in query<Hunger>() {
        let n = takes(e)
        e.Hunger.value = n
    }
}
`),
    ).toEqual([]);
  });

  it('still refuses the outer loop after a nested one has closed', () => {
    /*
     * **The case that made the test below insufficient.** Clearing the requirement set instead of
     * restoring it leaves it `null`, which means "not in a loop" and skips the check altogether —
     * so a version that forgot to restore passed every other test here, failing open. This asks
     * for a component the *outer* loop never required, after an inner loop has been and gone.
     */
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn f(world: World) {
    for a in query<Hunger>() {
        for b in query<Health>() {
            b.Health.current = 1
        }
        a.Health.current = 2
    }
}
`);
    expect(errors[0]?.code).toBe('DS0285');
    expect(errors[0]?.message).toContain('Health');
  });

  it('lets an outer binding reach its own components inside a nested loop', () => {
    /*
     * **A nested loop does not stop the outer loop's entity from being what it was selected for.**
     * `a` is still an entity with `Hunger` inside a loop over `Health`. Tracking requirements per
     * *loop* rather than per *binding* made every outer binding unreachable in a nested body, which
     * refuses correct code — found by an emitter test, not by a checker one.
     */
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn f(world: World) {
    for a in query<Hunger>() {
        for b in query<Health>() {
            a.Hunger.value = b.Health.current
        }
    }
}
`),
    ).toEqual([]);
  });

  it('still refuses a component the binding\'s own loop did not require', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn f(world: World) {
    for a in query<Hunger>() {
        for b in query<Health>() {
            a.Health.current = 1
        }
    }
}
`);
    expect(errors[0]?.code).toBe('DS0285');
    expect(errors[0]?.message).toContain('bound `a`');
  });

  it('gives a shadowed name back to the outer loop when the inner one ends', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger>() {
        for e in query<Health>() {
            e.Health.current = 1
        }
        e.Health.current = 2
    }
}
`);
    expect(errors[0]?.code).toBe('DS0285');
  });

  it('restores the outer requirement set after a nested loop', () => {
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn f(world: World) {
    for a in query<Hunger>() {
        for b in query<Health>() {
            b.Health.current = 1
        }
        a.Hunger.value = 2
    }
}
`),
    ).toEqual([]);
  });
});


describe('what a system touches is inferred, and the declaration is checked against it', () => {
  it('infers a write made directly in the update body', () => {
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }

system Feeder {
    writes Hunger
    update { for e in query<Hunger>() { e.Hunger.value = 1 } }
}
`),
    ).toEqual([]);
  });

  it('infers a write made through a called function', () => {
    /*
     * The whole reason inference propagates: the write is a call away, and an author who declared
     * only what the update body mentions would be wrong.
     *
     * **Asserted with `allIn` rather than `errorsIn`, and that matters.** Without propagation the
     * system infers no write at all, so `writes Hunger` reads as *over-wide* — a warning, which an
     * errors-only assertion sails straight past. The perturbation that removes propagation passed
     * this test until it looked at warnings too.
     */
    expect(
      allIn(`
component Hunger { value: f64 = 0 }

fn bump(world: World, e: Entity) {
    e.Hunger.value = 1
}

system Feeder {
    writes Hunger
    update { for e in query<Hunger>() { bump(world, e) } }
}
`),
    ).toEqual([]);
  });

  it('refuses a write the declaration omits, naming the system and the component', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

system Feeder {
    reads Hunger
    update { for e in query<Hunger>() { e.Hunger.value = 1 } }
}
`);
    expect(errors[0]?.code).toBe('DS0288');
    expect(errors[0]?.message).toContain('Feeder');
    expect(errors[0]?.message).toContain('Hunger');
  });

  it('refuses a write the declaration omits when it happens inside a helper', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

fn bump(world: World, e: Entity) {
    e.Hunger.value = 1
}

system Feeder {
    reads Hunger
    update { for e in query<Hunger>() { bump(world, e) } }
}
`);
    expect(errors[0]?.code).toBe('DS0288');
  });

  it('takes `writes` alone as covering the read, exactly as the engine does', () => {
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }

system Feeder {
    writes Hunger
    update { for e in query<Hunger>() { e.Hunger.value = e.Hunger.value + 1 } }
}
`),
    ).toEqual([]);
  });

  it('counts a component only ever assigned to as read as well as written', () => {
    /*
     * `writes` implies `reads`, the way `BoundSystem`'s constructor does it. Isolated here because
     * it used to be redundant: the assignment target was also walked as a read, so removing either
     * defence changed nothing and neither was tested. A plain assignment's target is no longer
     * walked as a read, which leaves this rule as the only thing supplying it.
     */
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }

system Feeder {
    writes Hunger
    update { for e in query<Hunger>() { e.Hunger.value = 1 } }
}
`),
    ).toEqual([]);
  });

  it('warns on a declaration wider than the body, rather than refusing it', () => {
    const all = allIn(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

system Feeder {
    writes Hunger
    writes Health
    update { for e in query<Hunger>() { e.Hunger.value = 1 } }
}
`);
    const warnings = all.filter((d) => d.severity === 'warning');
    expect(warnings[0]?.code).toBe('DS0291');
    expect(warnings[0]?.message).toContain('Health');
    expect(all.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('says nothing about a system that declares nothing at all', () => {
    /* Declaring nothing leaves the whole question to inference, which is a supported way to write
       one. Warning about every component such a system does not touch would make the quiet form
       the noisy one. */
    expect(
      allIn(`
component Hunger { value: f64 = 0 }

system Feeder {
    update { for e in query<Hunger>() { e.Hunger.value = 1 } }
}
`),
    ).toEqual([]);
  });

  it('refuses a declared name that is not a component', () => {
    const errors = errorsIn(`
system Feeder {
    reads Nothing
    update { }
}
`);
    expect(errors[0]?.code).toBe('DS0286');
    expect(errors[0]?.message).toContain('constrains nothing');
  });

  it('type-checks a system body at all', () => {
    /* There was no `checkSystem` when the form landed, so a system body was parsed and never
       looked at — every type error inside one was silently accepted. */
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

system Feeder {
    update { for e in query<Hunger>() { e.Hunger.missing = 1 } }
}
`);
    expect(errors[0]?.code).toBe('DS0203');
  });
});


describe('the inferred sets themselves, which no diagnostic can see', () => {
  /*
   * **`writes` implies `reads` matters for what is *emitted*, not for what is refused.**
   *
   * A system declaring `writes Hunger` has `Hunger` in its declared reads too, so a missing
   * implication on the inference side produces *fewer* inferred reads and therefore fewer errors —
   * every diagnostic test went on passing with the rule removed. What it actually changes is the
   * metadata the host builds a schedule from, which is reachable only by asking the function.
   */
  const accessOf = (source: string, name: string) => {
    const parsed = parse(source, 'm.drs');
    expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const model = collectEntityModel(parsed.module, {
      resolveTypeRef: () => ({ kind: 'primitive', name: 'f64' }),
      report: () => {},
      taken: () => false,
    });
    const found = inferAccess(parsed.module, model).get(name);
    return {
      reads: [...(found?.reads ?? [])].sort(),
      writes: [...(found?.writes ?? [])].sort(),
    };
  };

  it('puts a component that is only ever written into reads as well', () => {
    expect(
      accessOf(
        `
component Hunger { value: f64 = 0 }

system Feeder {
    update { for e in query<Hunger>() { e.Hunger.value = 1 } }
}
`,
        'Feeder',
      ),
    ).toEqual({ reads: ['Hunger'], writes: ['Hunger'] });
  });

  it('keeps a component that is only read out of writes', () => {
    expect(
      accessOf(
        `
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

system Feeder {
    update {
        for e in query<Hunger, Health>() {
            e.Hunger.value = e.Health.current
        }
    }
}
`,
        'Feeder',
      ),
    ).toEqual({ reads: ['Health', 'Hunger'], writes: ['Hunger'] });
  });

  it('carries a helper\'s access up into the system that calls it', () => {
    expect(
      accessOf(
        `
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

fn bump(world: World, e: Entity) {
    e.Hunger.value = 1
}

fn look(e: Entity) -> f64 {
    return e.Health.current
}

system Feeder {
    update {
        for e in query<Hunger, Health>() {
            bump(world, e)
            let seen = look(e)
        }
    }
}
`,
        'Feeder',
      ),
    ).toEqual({ reads: ['Health', 'Hunger'], writes: ['Hunger'] });
  });
});

describe('a query loop may not await', () => {
  it('refuses an await directly in the loop body, naming the cursor', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

task t(world: World) {
    for e in query<Hunger>() {
        await fixedTime(1s)
    }
}
`);
    expect(errors[0]?.code).toBe('DS0289');
    expect(errors[0]?.message).toContain('cursor');
  });

  it('refuses an await nested inside an if in the loop body', () => {
    /* Where one would actually be written. A version checking only the loop's direct statements
       passes this, which is why it is separate from the case above. */
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

task t(world: World) {
    for e in query<Hunger>() {
        if true {
            await fixedTime(1s)
        }
    }
}
`);
    expect(errors[0]?.code).toBe('DS0289');
  });

  it('refuses an await inside a while inside the loop', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

task t(world: World) {
    for e in query<Hunger>() {
        while true {
            await fixedTime(1s)
        }
    }
}
`);
    expect(errors[0]?.code).toBe('DS0289');
  });

  it('leaves an await outside the loop alone', () => {
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }

task t(world: World) {
    for e in query<Hunger>() {
        e.Hunger.value = 1
    }
    await fixedTime(1s)
}
`),
    ).toEqual([]);
  });

  it('refuses an await in a loop nested inside another loop', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }
component Health { current: f64 = 0 }

task t(world: World) {
    for a in query<Hunger>() {
        for b in query<Health>() {
            await fixedTime(1s)
        }
    }
}
`);
    expect(errors.filter((e) => e.code === 'DS0289').length).toBeGreaterThan(0);
  });
});

describe('a query needs a world in scope', () => {
  it('refuses a query in a function that declares no world', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

fn f() {
    for e in query<Hunger>() {
        e.Hunger.value = 1
    }
}
`);
    expect(errors[0]?.code).toBe('DS0295');
    expect(errors[0]?.message).toContain('world');
  });

  it('takes the world a function declares as a parameter', () => {
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger>() {
        e.Hunger.value = 1
    }
}
`),
    ).toEqual([]);
  });

  it('gives a system its own world without one being declared', () => {
    expect(
      errorsIn(`
component Hunger { value: f64 = 0 }

system Feeder {
    writes Hunger
    update { for e in query<Hunger>() { e.Hunger.value = 1 } }
}
`),
    ).toEqual([]);
  });

  it('lets a task query and then await, which is why the cursor refusal is reachable', () => {
    /* A task with a world can hold a query loop, and a task is the one place `await` is legal —
       so the two meet, and `DS0289` is the thing that keeps a cursor from crossing a frame. */
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

task t(world: World) {
    for e in query<Hunger>() {
        await fixedTime(1s)
    }
}
`);
    expect(errors[0]?.code).toBe('DS0289');
  });

  it('refuses two worlds in one body, because a query could not say which', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

fn f(a: World, b: World) {
    for e in query<Hunger>() {
        e.Hunger.value = 1
    }
}
`);
    expect(errors[0]?.code).toBe('DS0296');
  });

  it('does not leak a world out of the function that declared it', () => {
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }

fn withWorld(world: World) {
    for e in query<Hunger>() {
        e.Hunger.value = 1
    }
}

fn without() {
    for e in query<Hunger>() {
        e.Hunger.value = 1
    }
}
`);
    expect(errors[0]?.code).toBe('DS0295');
  });

  it('does not leak a system\'s world into a handler checked after it', () => {
    /*
     * **The case that made the leak test above insufficient.** A `fn` assigns the world on entry
     * from its own parameters, so a sibling function is unaffected whether or not the previous body
     * restored anything. An `on` handler assigns nothing — so without the restore it inherits
     * whatever the last system left behind, and a query in it would compile against a `$view`
     * parameter its generated function does not have.
     */
    const errors = errorsIn(`
component Hunger { value: f64 = 0 }
event Tick { at: f64 = 0 }

system Feeder {
    writes Hunger
    update { for e in query<Hunger>() { e.Hunger.value = 1 } }
}

on Tick as tick {
    for e in query<Hunger>() {
        e.Hunger.value = 2
    }
}
`);
    expect(errors[0]?.code).toBe('DS0295');
  });

  it('lets a consumer declare their own `World` record, which wins over the host type', () => {
    /* `lookupData` runs before the fallback, so a declared record shadows it — a name collision
       somebody can see, rather than a query silently running against the wrong thing. */
    const errors = errorsIn(`
data World { seed: f64 = 0 }
component Hunger { value: f64 = 0 }

fn f(world: World) {
    for e in query<Hunger>() {
        e.Hunger.value = 1
    }
}
`);
    /* Still accepted as *the* world by name, which is the documented trade — but the type it
       resolves to is the consumer's record, so `world.seed` reads. */
    expect(errors).toEqual([]);
  });
});

describe('a prefab is a description and not a program', () => {
  it('accepts constants', () => {
    expect(
      errorsIn(`
component Health { current: f64 = 0, maximum: f64 = 0 }

prefab Guard {
    Health { current: 100, maximum: 100 }
}
`),
    ).toEqual([]);
  });

  it('refuses a value computed at spawn time', () => {
    /* `definePrefab` takes values, not thunks — a computed value has nowhere to be computed on the
       other side, and a prefab that had to be run could not be inspected or serialised. */
    const errors = errorsIn(`
component Health { current: f64 = 0 }

fn roll() -> f64 {
    return 100
}

prefab Guard {
    Health { current: roll() }
}
`);
    expect(errors[0]?.code).toBe('DS0297');
    expect(errors[0]?.message).toContain('constant');
  });

  it('refuses a component the module never declared', () => {
    const errors = errorsIn(`
prefab Guard {
    Nothing {}
}
`);
    expect(errors[0]?.code).toBe('DS0286');
  });

  it('refuses a field the component does not have', () => {
    const errors = errorsIn(`
component Health { current: f64 = 0 }

prefab Guard {
    Health { missing: 1 }
}
`);
    expect(errors[0]?.code).toBe('DS0203');
  });

  it('refuses a value of the wrong type', () => {
    const errors = errorsIn(`
component Label { text: String = "" }

prefab Guard {
    Label { text: 1 }
}
`);
    expect(errors[0]?.code).toBe('DS0208');
  });

  it('takes a negated constant, which is a literal with a sign on it', () => {
    expect(
      errorsIn(`
component Offset { by: f64 = 0 }

prefab Back {
    Offset { by: -5 }
}
`),
    ).toEqual([]);
  });
});

describe('a handle a host hands back', () => {
  /**
   * A registry whose capability returns `Entity`, which is the shape `types.ts` asked for by name.
   *
   * The `entity` kind's own comment says a handle is assignable *to* `f64` and not from one, and
   * that what would make the asymmetry wrong is "a capability that hands back a handle as an `f64`
   * and expects it to keep working as one — which is why `drift/ecs` should return this type once
   * it can name it". This is that test.
   */
  const registry = () => {
    const r = createRegistry();
    r.addType({ module: 'drift/ecs', name: 'World', doc: 'A world.' });
    r.add(
      defineCapability({
        module: 'drift/ecs',
        name: 'nearest',
        signature: 'fn(world: World, x: f32) -> Entity',
        params: [
          { name: 'world', type: 'World' },
          { name: 'x', type: 'f32' },
        ],
        returns: 'Entity',
        effects: ['ecs.read'],
        deterministic: true,
        doc: 'The nearest entity.',
        implementation: 'World.nearest',
      }),
    );
    return r;
  };

  const errorsWithRegistry = (source: string): { code: string; message: string }[] => {
    const parsed = parse(source, 'm.drs');
    const parseErrors = parsed.diagnostics.filter((d) => d.severity === 'error');
    if (parseErrors.length > 0) {
      return parseErrors.map((d) => ({ code: d.code, message: d.message }));
    }
    return check(parsed.module, 'm.drs', registry())
      .diagnostics.filter((d) => d.severity === 'error')
      .map((d) => ({ code: d.code, message: d.message }));
  };

  const SOURCE =
    'import { nearest } from "drift/ecs"\n\n' +
    'component Health {\n    current: f64 = 0\n}\n\n' +
    'system S {\n    reads Health\n    writes Health\n\n    update {\n' +
    '        let who = ecs.nearest(world, 1)\n' +
    '        who.Health.current = 1\n' +
    '    }\n}\n';

  it('is a handle, so a component reads through it', () => {
    /* Until 1.6.0 this was `DS0203 \`Entity\` has no fields`, because the registry path resolved
       the name to a `primitive` rather than to the handle kind. The two resolvers disagreed about
       one word, and only the written-annotation one had ever been exercised. */
    expect(errorsWithRegistry(SOURCE)).toEqual([]);
  });

  it('needs no `mut`, because a handle is an address rather than a container', () => {
    /* The second half of the same bug: `checkWritable` exempts the `entity` kind, so a handle typed
       as a primitive was also refused with `DS0201` for a keyword that would have described the
       wrong thing. */
    expect(errorsWithRegistry(SOURCE).map((e) => e.code)).not.toContain('DS0201');
  });

  it('still refuses an arbitrary number where a handle is wanted', () => {
    /* The asymmetry survives the fix. A handle crosses into an `f64`; an `f64` does not become a
       handle, or the generational check would be back where it started. */
    const source =
      'component Health {\n    current: f64 = 0\n}\n\n' +
      'fn f(n: f64) {\n    n.Health.current = 1\n}\n';
    expect(errorsWithRegistry(source).map((e) => e.code)).toContain('DS0203');
  });
});

/**
 * **Reported from outside 2026-08-28: the compiler and a host's runtime gave opposite instructions
 * about the same line.**
 *
 * A component named in `query<…>` is one the host's runtime treats as read — the engine that
 * reported this refuses the query unless the component is in `reads` or `writes`, because a
 * schedule derived from declarations is wrong the moment a system touches more than it says. This
 * analysis walked a loop's *body* and never its *terms*, so the declaration the runtime demanded
 * was one nothing here counted: `DS0291` fired on it as unused, and following that advice produced
 * a module that compiled clean and threw once a tick.
 *
 * Two diagnostics change direction together, which is why the pair is tested as a pair: `DS0291`
 * stops calling a query's declaration unused, and `DS0288` starts catching the omission the runtime
 * used to catch — at compile time, where nobody is watching a car move in jerks.
 *
 * **A `without` term is not a read**, and that is the host's rule rather than a simplification: an
 * exclusion never looks inside the component, and an entity a `without` matched is not in the
 * result at all.
 */
describe('what a query loop counts as read', () => {
  it('counts a queried component as read, so its declaration is not called unused', () => {
    /* `Gait` is only ever queried — no field of it is touched — which is exactly the shape that
       used to be warned about. */
    const all = allIn(`
component Gait { phase: f64 = 0 }
component Health { current: f64 = 0 }

system Walker {
    reads Gait
    writes Health
    update { for e in query<Gait, Health>() { e.Health.current = 1 } }
}
`);
    expect(all.filter((d) => d.code === 'DS0291')).toEqual([]);
    expect(all.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('and refuses the omission the runtime would have thrown on', () => {
    const errors = errorsIn(`
component Gait { phase: f64 = 0 }
component Health { current: f64 = 0 }

system Walker {
    writes Health
    update { for e in query<Gait, Health>() { e.Health.current = 1 } }
}
`);
    expect(errors[0]?.code).toBe('DS0288');
    expect(errors[0]?.message).toContain('Gait');
  });

  it('counts a `with` term too, because it reaches the same host call', () => {
    const all = allIn(`
component Gait { phase: f64 = 0 }
component Grounded { on: bool = true }

system Walker {
    writes Gait
    reads Grounded
    update { for e in query<Gait>().with<Grounded>() { e.Gait.phase = 0 } }
}
`);
    expect(all.filter((d) => d.code === 'DS0291')).toEqual([]);
    expect(all.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('does not count a `without` term, so declaring one is still called unused', () => {
    const all = allIn(`
component Gait { phase: f64 = 0 }
component Still { held: bool = true }

system Walker {
    writes Gait
    reads Still
    update { for e in query<Gait>().without<Still>() { e.Gait.phase = 0 } }
}
`);
    const warnings = all.filter((d) => d.code === 'DS0291');
    expect(warnings[0]?.message).toContain('Still');
    expect(all.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('and does not demand a declaration for one either', () => {
    expect(
      allIn(`
component Gait { phase: f64 = 0 }
component Still { held: bool = true }

system Walker {
    writes Gait
    update { for e in query<Gait>().without<Still>() { e.Gait.phase = 0 } }
}
`).filter((d) => d.severity === 'error'),
    ).toEqual([]);
  });

  /**
   * An `entity` term stands for its own component and everything it requires, and the runtime is
   * handed every one of them — so all of them are read, not just the name written in the source.
   */
  it('expands an entity term, because the host is handed what the entity requires', () => {
    const all = allIn(`
component Gait { phase: f64 = 0 }
component Health { current: f64 = 0 }

entity Walker {
    require Gait
    require Health
}

system Mover {
    writes Gait
    reads Health
    update { for e in query<Walker>() { e.Gait.phase = 0 } }
}
`);
    expect(all.filter((d) => d.code === 'DS0291')).toEqual([]);
    expect(all.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('counts a query inside a helper the system calls', () => {
    const all = allIn(`
component Gait { phase: f64 = 0 }

fn walk(world: World) {
    for e in query<Gait>() { e.Gait.phase = 0 }
}

system Walker {
    writes Gait
    update { walk(world) }
}
`);
    expect(all.filter((d) => d.severity === 'error')).toEqual([]);
    expect(all.filter((d) => d.code === 'DS0291')).toEqual([]);
  });
});

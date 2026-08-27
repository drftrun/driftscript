import { describe, expect, it } from 'vitest';
import { parse } from '../parser.ts';
import { check } from './checker.ts';

const checkSource = (source: string) => check(parse(source, 'a.drs').module, 'a.drs');

const PULSE = `data PulseState {
    phase: f32 = 0
}

fn update(state: mut PulseState, dt: f32) {
    state.phase += dt
}
`;

describe('the checker', () => {
  it('accepts the pulse example', () => {
    expect(checkSource(PULSE).diagnostics).toEqual([]);
  });

  it('rejects assigning through an immutable parameter', () => {
    const { diagnostics } = checkSource(
      'data P {\n    phase: f32 = 0\n}\n\nfn f(state: P, dt: f32) {\n    state.phase += dt\n}\n',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('DS0201');
    expect(diagnostics[0].message).toContain('state');
    expect(diagnostics[0].message).toContain('mut');
  });

  it('rejects a field default whose type does not match its declaration', () => {
    const { diagnostics } = checkSource('data P {\n    name: f32 = "door"\n}\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('DS0202');
  });

  it('rejects a member the data declaration does not have', () => {
    const { diagnostics } = checkSource(
      'data P {\n    phase: f32 = 0\n}\n\nfn f(state: mut P, dt: f32) {\n    state.missing += dt\n}\n',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('DS0203');
    expect(diagnostics[0].message).toContain('missing');
  });

  it('rejects a reference to a type that was never declared', () => {
    const { diagnostics } = checkSource(
      'fn f(state: mut Nowhere, dt: f32) {\n    state.a += dt\n}\n',
    );
    expect(diagnostics.some((d) => d.code === 'DS0204')).toBe(true);
  });

  it('does not cascade from one unknown type into a diagnostic per use', () => {
    const { diagnostics } = checkSource(
      'fn f(state: mut Nowhere, dt: f32) {\n    state.a += dt\n    state.b += dt\n    state.c += dt\n}\n',
    );
    expect(diagnostics).toHaveLength(1);
  });

  it('rejects a name that is not in scope', () => {
    const { diagnostics } = checkSource(
      'data P {\n    phase: f32 = 0\n}\n\nfn f(state: mut P, dt: f32) {\n    state.phase += missing\n}\n',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('DS0205');
    expect(diagnostics[0].message).toContain('missing');
  });

  it('reports every independent error rather than stopping at the first', () => {
    const { diagnostics } = checkSource('data P {\n    a: f32 = "x"\n    b: f32 = "y"\n}\n');
    expect(diagnostics).toHaveLength(2);
  });

  it('rejects a duplicate data declaration rather than letting the second win', () => {
    const { diagnostics } = checkSource(
      'data P {\n    a: f32 = 0\n}\n\ndata P {\n    b: f32 = 0\n}\n',
    );
    expect(diagnostics.some((d) => d.code === 'DS0206')).toBe(true);
  });

  it('rejects a duplicate field in one declaration', () => {
    const { diagnostics } = checkSource('data P {\n    a: f32 = 0\n    a: f32 = 1\n}\n');
    expect(diagnostics.some((d) => d.code === 'DS0207')).toBe(true);
  });

  it('rejects assigning a String field from a number', () => {
    const { diagnostics } = checkSource(
      'data P {\n    label: String = "x"\n    n: f32 = 0\n}\n\nfn f(p: mut P) {\n    p.label += p.n\n}\n',
    );
    expect(diagnostics.some((d) => d.code === 'DS0208')).toBe(true);
  });

  it('records a resolved type for every expression it accepted', () => {
    const { types, diagnostics } = checkSource(PULSE);
    expect(diagnostics).toEqual([]);
    const resolved = [...types.values()].map((t) => t.kind);
    expect(resolved).toContain('primitive');
    expect(resolved).not.toContain('error');
  });

  it('exposes each declared data type by name, which is what lowering reads', () => {
    const { data } = checkSource(PULSE);
    expect([...data.keys()]).toEqual(['PulseState']);
  });
});

describe('a record with a base', () => {
  const check1 = (source: string) => {
    const parsed = parse(source, 'w.drs');
    return check(parsed.module, 'w.drs');
  };

  const DOG = 'data Dog {\n    name: String = ""\n    energy: f32 = 1\n}\n';

  it('lays a subtype out as base fields then own fields', () => {
    /*
     * The order is what `__drift.shapes` carries and what a migration reads, so it is asserted
     * rather than assumed. Own-fields-first would also "work" until the first hot reload.
     */
    const result = check1(`${DOG}\ndata Wolf : Dog {\n    packSize: i32 = 0\n}\n`);
    const wolf = result.data.get('Wolf');
    expect(wolf?.kind === 'data' && [...wolf.fields.keys()]).toEqual(['name', 'energy', 'packSize']);
  });

  it('flattens a chain of three, base-most first', () => {
    const result = check1(
      'data A {\n    a: f32 = 0\n}\n\ndata B : A {\n    b: f32 = 0\n}\n\ndata C : B {\n    c: f32 = 0\n}\n',
    );
    const c = result.data.get('C');
    expect(c?.kind === 'data' && [...c.fields.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('refuses an inheritance cycle, naming the whole cycle rather than the closing edge', () => {
    const result = check1('data A : B {\n}\n\ndata B : A {\n}\n');
    const cycle = result.diagnostics.find((d) => d.code === 'DS0503');
    expect(cycle).toBeDefined();
    expect(cycle?.message).toContain('A');
    expect(cycle?.message).toContain('B');
  });

  it('refuses a record that names itself as its base', () => {
    const result = check1('data A : A {\n}\n');
    expect(result.diagnostics.map((d) => d.code)).toContain('DS0503');
  });

  it('refuses a subtype that redeclares a base field, even at the same type', () => {
    const result = check1(`${DOG}\ndata Wolf : Dog {\n    energy: f32 = 2\n}\n`);
    const clash = result.diagnostics.find((d) => d.code === 'DS0504');
    expect(clash).toBeDefined();
    /* Both records are named, because the reader has to open one of them and does not yet know
       which. */
    expect(clash?.message).toContain('Dog');
    expect(clash?.message).toContain('energy');
  });

  it('refuses a base that is an enum', () => {
    const result = check1('enum E {\n    A\n}\n\ndata W : E {\n}\n');
    expect(result.diagnostics.map((d) => d.code)).toContain('DS0505');
  });

  it('refuses a base that is not declared at all', () => {
    const result = check1('data W : Nope {\n}\n');
    expect(result.diagnostics.map((d) => d.code)).toContain('DS0505');
  });

  it('keeps a subtype usable after refusing its base, rather than erasing it', () => {
    /* A record whose base is wrong still has its own fields, and reporting one error about the base
       beats reporting one about the base and five about every use of the record. */
    const result = check1('data W : Nope {\n    a: f32 = 0\n}\n');
    const w = result.data.get('W');
    expect(w?.kind === 'data' && [...w.fields.keys()]).toEqual(['a']);
  });
});

describe('a subtype where its base is expected', () => {
  const check1 = (source: string) => check(parse(source, 'w.drs').module, 'w.drs');

  const PAIR =
    'data Dog {\n    energy: f32 = 1\n}\n\ndata Wolf : Dog {\n    packSize: i32 = 0\n}\n\n';

  it('passes a subtype to a parameter typed as the base', () => {
    const result = check1(
      `${PAIR}fn feed(d: mut Dog) {\n    d.energy = 1\n}\n\nfn go(w: mut Wolf) {\n    feed(w)\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('does not pass a base where the subtype is expected', () => {
    /* The direction that must not hold. Width subtyping one way is sound; the other way hands a
       function a record missing the fields it was written against. */
    const result = check1(
      `${PAIR}fn howl(w: mut Wolf) {\n}\n\nfn go(d: mut Dog) {\n    howl(d)\n}\n`,
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('accepts a subtype in a field typed as the base', () => {
    const result = check1(
      `${PAIR}data Kennel {\n    resident: Dog = Wolf { energy: 1, packSize: 4 }\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts a subtype in a return position typed as the base', () => {
    const result = check1(
      `${PAIR}fn adopt() -> Dog {\n    return Wolf { energy: 1, packSize: 4 }\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts a subtype bound to a let annotated with the base', () => {
    const result = check1(
      `${PAIR}fn go() {\n    let d: Dog = Wolf { energy: 1, packSize: 4 }\n}\n`,
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts a grandchild where the base is expected', () => {
    const result = check1(
      'data A {\n    a: f32 = 0\n}\n\ndata B : A {\n    b: f32 = 0\n}\n\ndata C : B {\n    c: f32 = 0\n}\n\n' +
        'fn take(x: mut A) {\n    x.a = 1\n}\n\nfn go(c: mut C) {\n    take(c)\n}\n',
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('does not relate two records that merely share a base', () => {
    /* Siblings are not each other's subtypes, and nothing about width subtyping suggests they are —
       but a check that walked to a common ancestor rather than up one chain would say they were. */
    const result = check1(
      'data A {\n    a: f32 = 0\n}\n\ndata B : A {\n    b: f32 = 0\n}\n\ndata C : A {\n    c: f32 = 0\n}\n\n' +
        'fn take(x: mut B) {\n}\n\nfn go(c: mut C) {\n    take(c)\n}\n',
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('does not relate two unrelated records with identical fields', () => {
    /* Nominal, not structural. Two records that happen to line up are still two types, and the day
       one of them gains a field the other does not, code that relied on the coincidence breaks
       somewhere else entirely. */
    const result = check1(
      'data A {\n    x: f32 = 0\n}\n\ndata B {\n    x: f32 = 0\n}\n\n' +
        'fn take(a: mut A) {\n}\n\nfn go(b: mut B) {\n    take(b)\n}\n',
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('does not claim a relation through a base clause that was refused', () => {
    const result = check1(
      'data Wolf : Nope {\n    packSize: i32 = 0\n}\n\ndata Dog {\n    energy: f32 = 1\n}\n\n' +
        'fn feed(d: mut Dog) {\n}\n\nfn go(w: mut Wolf) {\n    feed(w)\n}\n',
    );
    /* Two errors: the base does not exist, and the call is still wrong. The second is the one that
       matters — a refused clause must not leave a working relation behind it. */
    expect(result.diagnostics.map((d) => d.code)).toContain('DS0505');
    expect(result.diagnostics.length).toBeGreaterThan(1);
  });
});

describe('tasks, and the statements only a task can hold', () => {
  const codes = (source: string): string[] => {
    const { module, diagnostics } = parse(source, 't.drs');
    expect(diagnostics).toEqual([]);
    return check(module, 't.drs').diagnostics.map((d) => d.code);
  };

  it('refuses an `await` in an ordinary function, which has nowhere to be resumed', () => {
    expect(codes('fn go() {\n    await fixedTime(1s)\n}\n')).toContain('DS0266');
  });

  it('refuses a `scope` in an ordinary function, where it would close on the same tick', () => {
    expect(codes('task t() {\n}\n\nfn go() {\n    scope effect {\n        spawn t()\n    }\n}\n')).toContain(
      'DS0267',
    );
  });

  it('accepts both inside a task', () => {
    expect(
      codes('task inner() {\n}\n\ntask t() {\n    scope effect {\n        spawn inner()\n    }\n    await fixedTime(1s)\n}\n'),
    ).toEqual([]);
  });

  it('refuses spawning a function, and says it is called instead', () => {
    expect(codes('fn go() {\n}\n\ntask t() {\n    spawn go()\n}\n')).toContain('DS0268');
  });

  it('refuses spawning a name nothing declares', () => {
    expect(codes('task t() {\n    spawn nowhere()\n}\n')).toContain('DS0268');
  });

  it('checks a spawn against the task it names, by count and by type', () => {
    expect(codes('task hold(seconds: f32) {\n}\n\ntask t() {\n    spawn hold()\n}\n')).toContain('DS0269');
    expect(codes('task hold(seconds: f32) {\n}\n\ntask t() {\n    spawn hold(true)\n}\n')).toContain(
      'DS0269',
    );
    expect(codes('task hold(seconds: f32) {\n}\n\ntask t() {\n    spawn hold(1)\n}\n')).toEqual([]);
  });

  it('refuses a task and a function of one name, because a name is one thing', () => {
    expect(codes('fn settle() {\n}\n\ntask settle() {\n}\n')).toContain('DS0209');
  });

  it('refuses a duration that is not a number of seconds', () => {
    expect(codes('task t() {\n    await fixedTime(true)\n}\n')).toContain('DS0265');
  });
});

describe('awaiting a task', () => {
  const codes2 = (source: string): string[] =>
    check(parse(source, 't.drs').module, 't.drs').diagnostics.map((d) => d.code);
  const messages = (source: string): string[] =>
    check(parse(source, 't.drs').module, 't.drs').diagnostics.map((d) => d.message);

  it('names the three clocks when a mistyped one reaches it as a task', () => {
    expect(codes2('task t() {\n    await gameTime(1)\n}\n')).toContain('DS0268');
    expect(messages('task t() {\n    await gameTime(1)\n}\n').join(' ')).toContain('frameTime');
  });

  it('says a function has already finished, rather than that it is not a task', () => {
    expect(messages('fn go() {\n}\n\ntask t() {\n    await go()\n}\n').join(' ')).toContain(
      'already finished',
    );
  });

  it('checks the awaited task by count and by type', () => {
    expect(codes2('task hold(s: f32) {\n}\n\ntask t() {\n    await hold()\n}\n')).toContain('DS0269');
    expect(codes2('task hold(s: f32) {\n}\n\ntask t() {\n    await hold(true)\n}\n')).toContain('DS0269');
    expect(codes2('task hold(s: f32) {\n}\n\ntask t() {\n    await hold(1)\n}\n')).toEqual([]);
  });
});

describe('a numeric literal in a binary operation', () => {
  const codes3 = (source: string): string[] =>
    check(parse(source, 't.drs').module, 't.drs').diagnostics.map((d) => d.code);

  it('adapts to the other operand whichever side it is written on', () => {
    /*
     * **`a - 1` compiled and `1 - a` did not, for the same `a`.** The left operand was checked with
     * no expected type, so a bare literal fell to its default of `f32` and then disagreed with an
     * `f64` or an `i64` on the right — while the right operand had always been checked against the
     * left. An arithmetic rule that depends on which side the constant is written on is one nobody
     * would defend, and it is the first thing a consumer writing `f64` meets.
     */
    for (const type of ['f32', 'f64', 'i32', 'i64', 'u32']) {
      expect(codes3(`fn f(a: ${type}) -> ${type} {\n    return a - 1\n}\n`), `a - 1 on ${type}`).toEqual([]);
      expect(codes3(`fn f(a: ${type}) -> ${type} {\n    return 1 - a\n}\n`), `1 - a on ${type}`).toEqual([]);
    }
  });

  it('still refuses two operands that are both typed and disagree', () => {
    /* The control. Adapting a *literal* must not become implicit widening between two variables,
       which is the thing the language refuses on purpose. */
    expect(codes3('fn f(a: f32, b: f64) -> f64 {\n    return a - b\n}\n')).toContain('DS0230');
    expect(codes3('fn f(a: i32, b: i64) -> i64 {\n    return b - a\n}\n')).toContain('DS0230');
  });

  it('keeps the literal comparable on both sides too', () => {
    expect(codes3('fn f(a: f64) -> bool {\n    return 1 < a\n}\n')).toEqual([]);
    expect(codes3('fn f(a: f64) -> bool {\n    return a < 1\n}\n')).toEqual([]);
  });
});

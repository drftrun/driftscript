import { describe, expect, it } from 'vitest';
import { parse } from './parser.ts';

const PULSE = `data PulseState {
    phase: f32 = 0
}

fn update(state: mut PulseState, dt: f32) {
    state.phase += dt
}
`;

describe('the parser', () => {
  it('parses the pulse example with no diagnostics', () => {
    const { module, diagnostics } = parse(PULSE, 'pulse.drs');
    expect(diagnostics).toEqual([]);
    expect(module.decls).toHaveLength(2);
  });

  it('reads a data declaration with a typed, defaulted field', () => {
    const { module } = parse(PULSE, 'pulse.drs');
    const data = module.decls.find((d) => d.kind === 'data');
    expect(data).toBeDefined();
    if (data?.kind !== 'data') throw new Error('expected a data declaration');
    expect(data.name).toBe('PulseState');
    expect(data.fields).toHaveLength(1);
    expect(data.fields[0].name).toBe('phase');
    expect(data.fields[0].type).toMatchObject({ kind: 'primitive', name: 'f32' });
    expect(data.fields[0].default).toMatchObject({ kind: 'number', value: 0 });
  });

  it('records mut on the parameter rather than on the type', () => {
    const { module } = parse(PULSE, 'pulse.drs');
    const fn = module.decls.find((d) => d.kind === 'fn');
    if (fn?.kind !== 'fn') throw new Error('expected a fn declaration');
    expect(fn.params.map((p) => [p.name, p.mutable])).toEqual([
      ['state', true],
      ['dt', false],
    ]);
    expect(fn.params[0].type).toMatchObject({ kind: 'named', name: 'PulseState' });
    expect(fn.params[1].type).toMatchObject({ kind: 'primitive', name: 'f32' });
  });

  it('parses a compound assignment into a target, an operator and a value', () => {
    const { module } = parse(PULSE, 'pulse.drs');
    const fn = module.decls.find((d) => d.kind === 'fn');
    if (fn?.kind !== 'fn') throw new Error('expected a fn declaration');
    expect(fn.body).toHaveLength(1);
    expect(fn.body[0]).toMatchObject({
      kind: 'compoundAssign',
      op: '+=',
      target: { kind: 'member', name: 'phase', target: { kind: 'ident', name: 'state' } },
      value: { kind: 'ident', name: 'dt' },
    });
  });

  it('parses an import and keeps the module string verbatim', () => {
    const { module, diagnostics } = parse('import { play } from "drift/audio"\n', 'a.drs');
    expect(diagnostics).toEqual([]);
    expect(module.imports).toHaveLength(1);
    expect(module.imports[0]).toMatchObject({ module: 'drift/audio', names: ['play'] });
  });

  it('parses several names in one import', () => {
    const { module, diagnostics } = parse(
      'import { play, stop, ambient } from "drift/audio"\n',
      'a.drs',
    );
    expect(diagnostics).toEqual([]);
    expect(module.imports[0].names).toEqual(['play', 'stop', 'ambient']);
  });

  it('parses a namespace the import names for itself', () => {
    const { module, diagnostics } = parse(
      'import { sprite } from "drift/2d" as sprites\n',
      'a.drs',
    );
    expect(diagnostics).toEqual([]);
    expect(module.imports[0]).toMatchObject({
      module: 'drift/2d',
      names: ['sprite'],
      alias: 'sprites',
    });
  });

  it('records no alias when the import names none, so the segment still means the segment', () => {
    const { module } = parse('import { play } from "drift/audio"\n', 'a.drs');
    expect(module.imports[0].alias).toBeUndefined();
  });

  it('takes a soft keyword as a namespace, the way it takes one as any other name', () => {
    const { module, diagnostics } = parse('import { play } from "drift/audio" as state\n', 'a.drs');
    expect(diagnostics).toEqual([]);
    expect(module.imports[0].alias).toBe('state');
  });

  it('refuses `as` with nothing after it', () => {
    const { diagnostics } = parse('import { play } from "drift/audio" as\n', 'a.drs');
    expect(diagnostics[0].code).toBe('DS0138');
  });

  /*
   * **The reason aliases exist**, asserted from the side that used to be silent. `drift/2d` is a
   * surface this language specifies and its namespace would be `2d`, which lexes as a number
   * followed by an identifier — so the failure used to arrive as ``\`d\` is not defined`` from
   * inside the author's own call, naming nothing they could act on. It is refused at the import
   * now, with the line to write.
   */
  it('refuses a module whose namespace is not an identifier, and says what to write', () => {
    const { diagnostics } = parse('import { sprite } from "drift/2d"\n', 'a.drs');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('DS0139');
    expect(diagnostics[0].message).toContain('`2d` is not an identifier');
    expect(diagnostics[0].message).toContain('from "drift/2d" as d2d');
  });

  it('accepts the same module once it is named', () => {
    const { diagnostics } = parse('import { sprite } from "drift/2d" as sprites\n', 'a.drs');
    expect(diagnostics).toEqual([]);
  });

  /*
   * A relative specifier brings its names in directly rather than through a namespace, so there is
   * nothing to spell and nothing to refuse. `./2d` is a legal file name and this must not break it.
   */
  it('leaves a relative import alone, whatever its last segment looks like', () => {
    const { diagnostics, module } = parse('import { Wave } from "./2d"\n', 'a.drs');
    expect(diagnostics).toEqual([]);
    expect(module.imports[0]).toMatchObject({ module: './2d', relative: true });
  });

  it('skips comments rather than treating them as syntax', () => {
    const { module, diagnostics } = parse(
      '// a leading comment\ndata P {\n    /* inline */ a: f32 = 0\n}\n',
      'a.drs',
    );
    expect(diagnostics).toEqual([]);
    expect(module.decls).toHaveLength(1);
  });

  it('carries a unit suffix onto the literal it belongs to', () => {
    const { module, diagnostics } = parse('data P {\n    delay: f32 = 250ms\n}\n', 'a.drs');
    expect(diagnostics).toEqual([]);
    const data = module.decls[0];
    if (data.kind !== 'data') throw new Error('expected a data declaration');
    expect(data.fields[0].default).toMatchObject({ kind: 'number', value: 250, unit: 'ms' });
  });

  it('reports a missing closing brace with a span and recovers rather than throwing', () => {
    const { diagnostics } = parse('data P {\n    phase: f32\n', 'a.drs');
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(diagnostics[0].code).toMatch(/^DS01/);
    expect(diagnostics[0].message).toContain('}');
  });

  it('resynchronises at the next declaration, so a second error is still reported', () => {
    const { diagnostics } = parse(
      'fn a(( {\n}\n\nfn b(( {\n}\n',
      'a.drs',
    );
    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
  });

  it('gives every declaration a span that covers its own source', () => {
    const { module } = parse(PULSE, 'pulse.drs');
    for (const decl of module.decls) {
      /* An `on` handler declares no name of its own — it names the event it listens for. */
      const named = decl.kind === 'on' ? decl.event : decl.name;
      expect(PULSE.slice(decl.span.start, decl.span.end)).toContain(named);
    }
  });

  /*
   * The soft-keyword rule, tested by the signatures that forced it.
   *
   * Every one of these is a signature a behaviour-scripting language will actually be asked to
   * parse, and `state` is the design's own canonical example. A keyword reserved in a binding
   * position rejects all eight, which is why `acceptIdentLike` exists — see `tokens.ts` for the
   * argument and for what it costs.
   */
  it.each([
    ['state', 'fn update(state: mut PulseState, dt: f32) {\n}\n'],
    ['from', 'fn lerp(from: f32, to: f32) {\n}\n'],
    ['data', 'fn process(data: Bytes) {\n}\n'],
    ['task', 'fn run(task: Job) {\n}\n'],
    ['scope', 'fn within(scope: Region) {\n}\n'],
    ['match', 'fn pick(match: Rule) {\n}\n'],
    ['on', 'fn place(on: Surface) {\n}\n'],
    ['as', 'fn cast(as: Kind) {\n}\n'],
  ])('accepts the soft keyword `%s` as a parameter name', (name, source) => {
    const { module, diagnostics } = parse(source, 'a.drs');
    expect(diagnostics).toEqual([]);
    const fn = module.decls[0];
    if (fn.kind !== 'fn') throw new Error('expected a fn declaration');
    expect(fn.params[0].name).toBe(name);
  });

  it('accepts a soft keyword as a field name and as an expression', () => {
    const { module, diagnostics } = parse(
      'data Door {\n    state: f32 = 0\n}\n\nfn step(state: mut Door, dt: f32) {\n    state.state += dt\n}\n',
      'a.drs',
    );
    expect(diagnostics).toEqual([]);
    const data = module.decls[0];
    if (data.kind !== 'data') throw new Error('expected a data declaration');
    expect(data.fields[0].name).toBe('state');
  });

  it('still reserves a hard keyword in a binding position', () => {
    const { diagnostics } = parse('fn f(fn: f32) {\n}\n', 'a.drs');
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
  });

  it('reports a lexical error rather than silently dropping it', () => {
    const { diagnostics } = parse('data P {\n    a # f32 = 0\n}\n', 'a.drs');
    expect(diagnostics.some((d) => d.code === 'DS0003')).toBe(true);
  });
});

describe('file imports and capability imports', () => {
  /*
   * The category is decided syntactically, at parse time, and never by a lookup.
   *
   * A specifier whose meaning depended on what a target manifest happened to contain would make the
   * same source mean two things in two builds, and the difference would surface as a linker refusal
   * about a file rather than as anything a reader could act on.
   */
  it('marks a relative specifier as a file and a bare one as a capability', () => {
    const parsed = parse('import { Dog } from "./dog"\nimport { play } from "drift/audio"\n', 'w.drs');
    expect(parsed.module.imports.map((i) => [i.module, i.relative])).toEqual([
      ['./dog', true],
      ['drift/audio', false],
    ]);
  });

  it('marks a parent-relative specifier as a file', () => {
    const parsed = parse('import { Dog } from "../lib/dog"\n', 'w.drs');
    expect(parsed.module.imports[0].relative).toBe(true);
  });

  it('does not mistake a std module for a file', () => {
    const parsed = parse('import { abs } from "std/math"\n', 'w.drs');
    expect(parsed.module.imports[0].relative).toBe(false);
  });
});

describe('a base clause', () => {
  /*
   * No new keyword. The clause is `:` between the name and the brace, which the lexer already
   * produces as punctuation. A keyword would be an eighth soft keyword bought for nothing, and
   * every soft keyword costs a place the parser has to disambiguate.
   */
  it('parses a base', () => {
    const parsed = parse('data Wolf : Dog {\n    packSize: i32 = 0\n}\n', 'w.drs');
    const decl = parsed.module.decls[0];
    expect(decl.kind === 'data' && decl.base?.name).toBe('Dog');
  });

  it('records where the base was written, so a refusal can point at it', () => {
    const source = 'data Wolf : Dog {\n    packSize: i32 = 0\n}\n';
    const parsed = parse(source, 'w.drs');
    const decl = parsed.module.decls[0];
    expect(decl.kind === 'data' && decl.base?.span).toEqual({
      start: source.indexOf('Dog'),
      end: source.indexOf('Dog') + 3,
    });
  });

  it('parses a record with no base as having none', () => {
    const parsed = parse('data Dog {\n    name: String = ""\n}\n', 'd.drs');
    const decl = parsed.module.decls[0];
    expect(decl.kind === 'data' && decl.base).toBeUndefined();
  });

  it('refuses a second base rather than taking the first', () => {
    /*
     * One base. Two raise field collision, layout order and diamond questions whose answers are all
     * arbitrary, and every one of those answers is load-bearing for the stable field ids Phase 5
     * builds. Refusing at the parser is where a person can still see what they wrote.
     */
    const parsed = parse('data Wolf : Dog, Animal {\n}\n', 'w.drs');
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    expect(parsed.diagnostics[0].message).toMatch(/one base|single base/i);
  });

  it('refuses a base clause with no name after it', () => {
    const parsed = parse('data Wolf : {\n}\n', 'w.drs');
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
  });

  it('still parses the fields of a record that has a base', () => {
    const parsed = parse('data Wolf : Dog {\n    packSize: i32 = 0\n    alpha: bool = false\n}\n', 'w.drs');
    const decl = parsed.module.decls[0];
    expect(decl.kind === 'data' && decl.fields.map((f) => f.name)).toEqual(['packSize', 'alpha']);
  });
});

const TASK = `task settle() {
    await fixedTime(500ms)
    await frameTime(1s)
}
`;

describe('the task form', () => {
  it('parses a task with two awaits', () => {
    const { module, diagnostics } = parse(TASK, 'task.drs');
    expect(diagnostics).toEqual([]);
    expect(module.decls).toHaveLength(1);

    const task = module.decls[0];
    if (task.kind !== 'task') throw new Error('expected a task declaration');
    expect(task.name).toBe('settle');
    expect(task.params).toHaveLength(0);
    expect(task.body).toHaveLength(2);
  });

  it('records the clock and the duration each await names', () => {
    const { module } = parse(TASK, 'task.drs');
    const task = module.decls[0];
    if (task.kind !== 'task') throw new Error('expected a task declaration');

    const [first, second] = task.body;
    if (first.kind !== 'await' || second.kind !== 'await') throw new Error('expected awaits');
    expect(first.clock).toBe('fixed');
    /* The unit is still on the node here. Erasure is lowering's job, so the parser keeps what was
       written and `500ms` becomes 0.5 further down. */
    expect(first.duration).toMatchObject({ kind: 'number', value: 500, unit: 'ms' });
    expect(second.clock).toBe('frame');
    expect(second.duration).toMatchObject({ kind: 'number', value: 1, unit: 's' });
  });

  it('takes parameters, which a spawn supplies and the frame carries', () => {
    const { module, diagnostics } = parse('task hold(seconds: f32) {\n    await fixedTime(seconds)\n}\n', 't.drs');
    expect(diagnostics).toEqual([]);
    const task = module.decls[0];
    if (task.kind !== 'task') throw new Error('expected a task declaration');
    expect(task.params).toHaveLength(1);
    expect(task.params[0].name).toBe('seconds');
  });

  it('reads an await of anything but the three clocks as a task, which the checker then names', () => {
    /* `await` takes a clock or a task, so the parser cannot tell a mistyped clock from a task it
       has not seen yet. It parses as a task; the checker has the table and says so, naming the
       three clocks when the name looks like one. */
    const { module, diagnostics } = parse('task t() {\n    await gameTime(1s)\n}\n', 't.drs');
    expect(diagnostics).toEqual([]);

    const task = module.decls[0];
    if (task.kind !== 'task') throw new Error('expected a task declaration');
    expect(task.body[0]).toMatchObject({ kind: 'awaitTask', task: 'gameTime' });
  });

  it('still allows `task` as a parameter name, because it is a soft keyword', () => {
    const { diagnostics } = parse('fn run(task: f32) -> f32 {\n    return task\n}\n', 't.drs');
    expect(diagnostics).toEqual([]);
  });
});

describe('component declarations', () => {
  it('parses a component with defaults', () => {
    const { module, diagnostics } = parse(
      'component Health {\n    current: f64 = 100\n    maximum: f64 = 100\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    expect(decl?.kind).toBe('component');
    if (decl?.kind !== 'component') throw new Error('expected a component');
    expect(decl.name).toBe('Health');
    expect(decl.fromHost).toBe(false);
    expect(decl.fields.map((f) => f.name)).toEqual(['current', 'maximum']);
    expect(decl.fields[0]?.default).toBeDefined();
  });

  it('parses the host-assertion direction', () => {
    const { module, diagnostics } = parse(
      'component Transform from host {\n    x: f64\n    y: f64\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'component') throw new Error('expected a component');
    expect(decl.fromHost).toBe(true);
    expect(decl.fields.map((f) => f.name)).toEqual(['x', 'y']);
  });

  it('refuses `from` followed by anything but `host`', () => {
    const { diagnostics } = parse('component Transform from engine {\n    x: f64\n}\n', 'x.drs');
    expect(diagnostics[0]?.code).toBe('DS0131');
    expect(diagnostics[0]?.message).toContain('host');
  });

  it('cannot spell the presence suffix at all, because `$` is not an identifier character', () => {
    /*
     * An optional field stores presence in `<name>$present`, and a column map is last-writer-wins,
     * so a field genuinely called `of$present` would overwrite the presence of `of` silently.
     * A parser check for it would be unreachable: the lexer refuses `$` in a name one layer down.
     * This asserts that, so the day `$` becomes legal the reservation gets a real home.
     */
    const { diagnostics } = parse('component T {\n    of$present: f64\n}\n', 'x.drs');
    expect(diagnostics[0]?.code).toBe('DS0003');
  });

  it('takes an optional field, which a record field could already be', () => {
    const { module, diagnostics } = parse('component Follow {\n    of: f64?\n}\n', 'x.drs');
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'component') throw new Error('expected a component');
    expect(decl.fields[0]?.type.kind).toBe('option');
  });

  it('carries an `@editor` annotation on a field', () => {
    const { module, diagnostics } = parse(
      'component P {\n    @editor(label: "Sight", range: 1m..150m)\n    sight: f64 = 40m\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'component') throw new Error('expected a component');
    expect(decl.fields[0]?.editor?.label).toBe('Sight');
    expect(decl.fields[0]?.editor?.range).toMatchObject({ min: 1, max: 150, unit: 'm' });
  });

  it('lets `component` still name a variable, because it is soft', () => {
    const { diagnostics } = parse('fn f() {\n    let component = 1\n}\n', 'x.drs');
    expect(diagnostics).toEqual([]);
  });
});

describe('entity declarations', () => {
  it('parses a require list and own fields', () => {
    const { module, diagnostics } = parse(
      'entity Animal {\n    require Transform\n    require Health\n    var target: f64?\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'entity') throw new Error('expected an entity');
    expect(decl.requires.map((r) => r.name)).toEqual(['Transform', 'Health']);
    expect(decl.fields.map((f) => f.name)).toEqual(['target']);
    expect(decl.fields[0]?.type.kind).toBe('option');
  });

  it('parses an entity that is only a name for a set', () => {
    const { module, diagnostics } = parse('entity Moving {\n    require Transform\n}\n', 'x.drs');
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'entity') throw new Error('expected an entity');
    expect(decl.fields).toEqual([]);
    expect(decl.requires).toHaveLength(1);
  });

  it('keeps a span on each requirement, so a refusal can point at one', () => {
    const source = 'entity Moving {\n    require Transform\n}\n';
    const { module } = parse(source, 'x.drs');
    const decl = module.decls[0];
    if (decl?.kind !== 'entity') throw new Error('expected an entity');
    const { start, end } = decl.requires[0]!.span;
    expect(source.slice(start, end)).toBe('Transform');
  });

  it('refuses a bare field, which would declare a component nobody wrote', () => {
    const { diagnostics } = parse('entity Animal {\n    target: f64\n}\n', 'x.drs');
    expect(diagnostics[0]?.code).toBe('DS0132');
    expect(diagnostics[0]?.message).toContain('require');
  });

  it('refuses `let`, because an entity field is state a system writes', () => {
    const { diagnostics } = parse('entity Animal {\n    let target: f64\n}\n', 'x.drs');
    expect(diagnostics[0]?.code).toBe('DS0132');
  });

  it('refuses `require` with no name after it', () => {
    const { diagnostics } = parse('entity Animal {\n    require\n}\n', 'x.drs');
    expect(diagnostics[0]?.code).toBe('DS0132');
    expect(diagnostics[0]?.message).toContain('component name');
  });

  it('lets `entity` still name a variable, because it is soft', () => {
    const { diagnostics } = parse('fn f() {\n    let entity = 1\n}\n', 'x.drs');
    expect(diagnostics).toEqual([]);
  });
});

describe('system declarations', () => {
  it('converts a rate to a whole tick stride', () => {
    const { module, diagnostics } = parse('system S {\n    update at 1Hz {\n    }\n}\n', 'x.drs');
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'system') throw new Error('expected a system');
    expect(decl.everyTicks).toBe(60);
  });

  it('reads every legal rate as the stride it is', () => {
    for (const [rate, stride] of [[2, 30], [4, 15], [15, 4], [60, 1]] as const) {
      const { module, diagnostics } = parse(`system S {\n    update at ${rate}Hz {\n    }\n}\n`, 'x.drs');
      expect(diagnostics, `${rate}Hz`).toEqual([]);
      const decl = module.decls[0];
      if (decl?.kind !== 'system') throw new Error('expected a system');
      expect(decl.everyTicks, `${rate}Hz`).toBe(stride);
    }
  });

  it('runs every step when `update` carries no rate', () => {
    const { module } = parse('system S {\n    update {\n    }\n}\n', 'x.drs');
    const decl = module.decls[0];
    if (decl?.kind !== 'system') throw new Error('expected a system');
    expect(decl.everyTicks).toBe(1);
  });

  it('refuses a rate that is not a whole number of fixed steps, naming the arithmetic', () => {
    const { diagnostics } = parse('system S {\n    update at 7Hz {\n    }\n}\n', 'x.drs');
    expect(diagnostics[0]?.code).toBe('DS0133');
    expect(diagnostics[0]?.message).toContain('8.57');
  });

  it('refuses a rate written in seconds', () => {
    const { diagnostics } = parse('system S {\n    update at 1s {\n    }\n}\n', 'x.drs');
    expect(diagnostics[0]?.code).toBe('DS0133');
    expect(diagnostics[0]?.message).toContain('wall-clock');
  });

  it('collects reads, writes and after with their spans', () => {
    const source =
      'system Feeder {\n    reads Hunger\n    writes Hunger\n    after Movement\n' +
      '    update {\n    }\n}\n';
    const { module, diagnostics } = parse(source, 'x.drs');
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'system') throw new Error('expected a system');
    expect(decl.reads.map((r) => r.name)).toEqual(['Hunger']);
    expect(decl.writes.map((w) => w.name)).toEqual(['Hunger']);
    expect(decl.after.map((a) => a.name)).toEqual(['Movement']);
    const { start, end } = decl.writes[0]!.span;
    expect(source.slice(start, end)).toBe('Hunger');
  });

  it('refuses a system with no update block', () => {
    const { diagnostics } = parse('system S {\n    reads Hunger\n}\n', 'x.drs');
    expect(diagnostics[0]?.code).toBe('DS0133');
    expect(diagnostics[0]?.message).toContain('ever runs');
  });

  it('refuses two update blocks, because `after` addresses one name', () => {
    const { diagnostics } = parse(
      'system S {\n    update {\n    }\n    update {\n    }\n}\n',
      'x.drs',
    );
    expect(diagnostics[0]?.code).toBe('DS0133');
  });

  it('lets every entity-form keyword but `query` name a variable', () => {
    /* Ten of the eleven are soft. `after` was the one this list caught: it is a clause head like
       `reads` and `writes`, was left out of the first draft entirely, and would otherwise have been
       hard by accident — taking a common word out of a consumer's namespace for nothing. */
    const { diagnostics } = parse(
      'fn f() {\n    let component = 1\n    let entity = 2\n    let system = 3\n' +
        '    let prefab = 4\n    let require = 5\n    let reads = 6\n    let writes = 7\n' +
        '    let update = 8\n    let at = 9\n    let after = 10\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
  });
});

describe('prefab declarations', () => {
  it('parses an empty component and a valued one', () => {
    const { module, diagnostics } = parse(
      'prefab Guard {\n    Transform {}\n    Health { current: 100 }\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'prefab') throw new Error('expected a prefab');
    expect(decl.components.map((c) => c.name)).toEqual(['Transform', 'Health']);
    expect(decl.components[0]?.values).toEqual([]);
    expect(decl.components[1]?.values[0]?.name).toBe('current');
  });

  it('takes several values in one component', () => {
    const { module, diagnostics } = parse(
      'prefab Guard {\n    Health { current: 100, maximum: 100 }\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'prefab') throw new Error('expected a prefab');
    expect(decl.components[0]?.values.map((v) => v.name)).toEqual(['current', 'maximum']);
  });

  it('keeps a span covering each component, so a refusal can point at one', () => {
    const source = 'prefab Guard {\n    Health { current: 100 }\n}\n';
    const { module } = parse(source, 'x.drs');
    const decl = module.decls[0];
    if (decl?.kind !== 'prefab') throw new Error('expected a prefab');
    const { start, end } = decl.components[0]!.span;
    expect(source.slice(start, end)).toBe('Health { current: 100 }');
  });

  it('refuses a value with no field name', () => {
    const { diagnostics } = parse('prefab Guard {\n    Health { 100 }\n}\n', 'x.drs');
    expect(diagnostics[0]?.code).toBe('DS0134');
  });

  it('refuses a component with no brace pair after it', () => {
    const { diagnostics } = parse('prefab Guard {\n    Health\n}\n', 'x.drs');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('lets `prefab` still name a variable, because it is soft', () => {
    const { diagnostics } = parse('fn f() {\n    let prefab = 1\n}\n', 'x.drs');
    expect(diagnostics).toEqual([]);
  });
});

describe('the query loop', () => {
  it('parses a query with filters', () => {
    const { module, diagnostics } = parse(
      'fn f() {\n    for e in query<Transform, Health>().with<Threat>().without<Dead>() {\n    }\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'fn') throw new Error('expected a fn');
    const stmt = decl.body[0];
    if (stmt?.kind !== 'forQuery') throw new Error('expected a query loop');
    expect(stmt.binding).toBe('e');
    expect(stmt.query.required).toHaveLength(2);
    expect(stmt.query.with).toHaveLength(1);
    expect(stmt.query.without).toHaveLength(1);
  });

  it('parses the plain form with no filters', () => {
    const { module, diagnostics } = parse(
      'fn f() {\n    for e in query<Hunger>() {\n    }\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'fn') throw new Error('expected a fn');
    const stmt = decl.body[0];
    if (stmt?.kind !== 'forQuery') throw new Error('expected a query loop');
    expect(stmt.query.with).toEqual([]);
    expect(stmt.query.without).toEqual([]);
  });

  it('takes several filters of each kind', () => {
    const { module, diagnostics } = parse(
      'fn f() {\n    for e in query<A>().with<B>().without<C>().with<D>() {\n    }\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'fn') throw new Error('expected a fn');
    const stmt = decl.body[0];
    if (stmt?.kind !== 'forQuery') throw new Error('expected a query loop');
    expect(stmt.query.with).toHaveLength(2);
    expect(stmt.query.without).toHaveLength(1);
  });

  it('holds statements in the body', () => {
    const { module, diagnostics } = parse(
      'fn f() {\n    for e in query<Hunger>() {\n        let x = 1\n        let y = 2\n    }\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'fn') throw new Error('expected a fn');
    const stmt = decl.body[0];
    if (stmt?.kind !== 'forQuery') throw new Error('expected a query loop');
    expect(stmt.body).toHaveLength(2);
  });

  it('refuses a query as a value, naming the form that is legal', () => {
    const { diagnostics } = parse('fn f() {\n    let q = query<Transform>()\n}\n', 'x.drs');
    expect(diagnostics[0]?.code).toBe('DS0135');
    expect(diagnostics[0]?.message).toContain('for');
  });

  it('refuses a query over nothing', () => {
    const { diagnostics } = parse('fn f() {\n    for e in query<>() {\n    }\n}\n', 'x.drs');
    expect(diagnostics[0]?.code).toBe('DS0135');
    expect(diagnostics[0]?.message).toContain('at least one');
  });

  it('refuses a filter that is not `with` or `without`', () => {
    const { diagnostics } = parse(
      'fn f() {\n    for e in query<A>().sorted<B>() {\n    }\n}\n',
      'x.drs',
    );
    expect(diagnostics[0]?.code).toBe('DS0135');
    expect(diagnostics[0]?.message).toContain('without');
  });

  it('refuses a filter taking two components', () => {
    const { diagnostics } = parse(
      'fn f() {\n    for e in query<A>().with<B, C>() {\n    }\n}\n',
      'x.drs',
    );
    expect(diagnostics[0]?.code).toBe('DS0135');
    expect(diagnostics[0]?.message).toContain('exactly one');
  });

  it('reads `for … in` over anything but `query` as a walk over a list', () => {
    /*
     * This used to be `DS0135`: `for` existed only over a query, so any other subject was a syntax
     * error. Lists landed in 1.6.0 and the two forms now share the keyword, told apart by the word
     * after `in` — `query` is a hard keyword, so no expression can begin with it and the test
     * cannot misread a list whose variable happens to be called that.
     *
     * Whether the subject *is* a list is the checker's question, not this one's.
     */
    const { module, diagnostics } = parse('fn f() {\n    for e in items {\n    }\n}\n', 'x.drs');
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'fn') throw new Error('expected a function');
    expect(decl.body[0]?.kind).toBe('forList');
  });

  it('suppresses a record literal in the subject, or the loop body would be one', () => {
    /* `for x in xs {` puts a brace on the same line as an identifier, which is exactly the
       record-literal shape — the same collision `if` and `while` already resolve this way. */
    const { module, diagnostics } = parse(
      'fn f() {\n    for e in items {\n        let n = 1\n    }\n}\n',
      'x.drs',
    );
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'fn') throw new Error('expected a function');
    const loop = decl.body[0];
    if (loop?.kind !== 'forList') throw new Error('expected a list walk');
    expect(loop.body).toHaveLength(1);
  });

  it('still reads `<` as a comparison outside a query', () => {
    /* The whole reason `query` is a hard keyword: making it soft would leave `q < 5` ambiguous
       between a comparison and the head of a query. Nothing else moved. */
    const { module, diagnostics } = parse('fn f() -> bool {\n    let q = 1\n    return q < 5\n}\n', 'x.drs');
    expect(diagnostics).toEqual([]);
    const decl = module.decls[0];
    if (decl?.kind !== 'fn') throw new Error('expected a fn');
    const stmt = decl.body[1];
    if (stmt?.kind !== 'return') throw new Error('expected a return');
    expect(stmt.value?.kind).toBe('binary');
  });
});

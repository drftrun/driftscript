import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';
import { parse } from '../parser.ts';
import { check } from '../check/checker.ts';
import { clearClockSource, setClockSource } from '../../runtime/clocks.ts';
import { loadModule } from '../../runtime/module.ts';
import type { Machine } from '../../runtime/machine.ts';
import { tickTasks } from '../../runtime/tasks.ts';

let steps = 0;

beforeEach(() => {
  steps = 0;
  setClockSource({
    fixedSteps: () => steps,
    fixedStep: () => 1 / 60,
    frame: () => 0,
    wall: () => 0,
  });
});

afterEach(() => {
  clearClockSource();
});

const compile = (source: string) => {
  const { code, diagnostics } = compileDriftScript(source, {
    filename: 't.drs',
    host: singleFileHost(),
    mode: 'development',
  });
  expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return code;
};

const load = async (source: string) =>
  loadModule(
    (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(compile(source))}`
    )) as Record<string, unknown>,
  );

const diagnostics = (source: string) => {
  const { module, diagnostics: parsed } = parse(source, 't.drs');
  expect(parsed).toEqual([]);
  return check(module, 't.drs').diagnostics;
};
const codes = (source: string): string[] => diagnostics(source).map((d) => d.code);

const DOOR =
  'event Open {\n    by: i32 = 0\n}\n\n' +
  'event Close {\n    by: i32 = 0\n}\n\n' +
  'state Closed {\n    on Open {\n        become Opening\n    }\n}\n\n' +
  'state Opening {\n    enter {\n        await fixedTime(500ms)\n        become Opened\n    }\n}\n\n' +
  'state Opened {\n    on Close {\n        become Closed\n    }\n}\n';

describe('a compiled state machine', () => {
  it('starts in the first state declared and transitions on an event', async () => {
    const module = await load(DOOR);
    const machine = (module.exports.createMachine as () => Machine)();

    expect(machine.current).toBe('Closed');
    machine.send('Open');
    expect(machine.current).toBe('Opening');

    machine.stop();
    module.scope.leave();
  });

  it('runs an entry block that suspends, and transitions when it finishes', async () => {
    const module = await load(DOOR);
    const machine = (module.exports.createMachine as () => Machine)();

    machine.send('Open');
    steps = 29;
    tickTasks();
    expect(machine.current).toBe('Opening');

    steps = 30;
    tickTasks();
    expect(machine.current).toBe('Opened');

    machine.stop();
    module.scope.leave();
  });

  it('makes a machine per call, so one script describes every door', async () => {
    const module = await load(DOOR);
    const a = (module.exports.createMachine as () => Machine)();
    const b = (module.exports.createMachine as () => Machine)();

    a.send('Open');

    expect(a.current).toBe('Opening');
    expect(b.current).toBe('Closed');

    a.stop();
    b.stop();
    module.scope.leave();
  });

  it('binds the payload where a handler named one, and omits the parameter where it did not', async () => {
    /* An unused parameter would be one nothing in the language can reach. */
    const code = compile(
      'event Open {\n    by: i32 = 0\n}\n\n' +
        'state Closed {\n    on Open as o {\n        become Opened\n    }\n}\n\n' +
        'state Opened {\n    on Open {\n        become Closed\n    }\n}\n',
    );
    expect(code).toContain('Open($m, o) {');
    expect(code).toContain('Open($m) {');
  });

  it('runs a handler that named a payload', async () => {
    const module = await load(
      'event Open {\n    by: i32 = 0\n}\n\n' +
        'state Closed {\n    on Open as o {\n        become Opened\n    }\n}\n\n' +
        'state Opened {\n    on Open {\n        become Closed\n    }\n}\n',
    );
    const machine = (module.exports.createMachine as () => Machine)();

    machine.send('Open', { by: 2 });
    expect(machine.current).toBe('Opened');

    machine.stop();
    module.scope.leave();
  });
});

describe('what a state machine refuses', () => {
  it('refuses a `become` naming a state nothing declares', () => {
    expect(
      codes('state A {\n    enter {\n        become Nowhere\n    }\n}\n'),
    ).toContain('DS0281');
  });

  it('refuses a `become` outside a state, where there is no machine to change', () => {
    expect(codes('state A {\n}\n\nfn go() {\n    become A\n}\n')).toContain('DS0283');
  });

  it('warns about a state nothing enters', () => {
    const found = diagnostics(
      'state A {\n    enter {\n        become A\n    }\n}\n\nstate Orphan {\n    enter {\n        become A\n    }\n}\n',
    ).filter((d) => d.code === 'DS0280');

    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    expect(found[0].message).toContain('Orphan');
  });

  it('warns about a state with no way out of it', () => {
    /* Review found a test whose machine had no exit and whose re-entrant guard was therefore
       deletable without any suite noticing. This is what makes that visible. */
    const found = diagnostics('state A {\n    enter {\n        become B\n    }\n}\n\nstate B {\n}\n').filter(
      (d) => d.code === 'DS0282',
    );

    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    expect(found[0].message).toContain('B');
  });

  it('refuses an `on` in a state for an event nothing declares', () => {
    expect(codes('state A {\n    on Nowhere {\n        become A\n    }\n}\n')).toContain('DS0270');
  });

  it('refuses two states of one name', () => {
    expect(codes('state A {\n    enter {\n        become A\n    }\n}\n\nstate A {\n}\n')).toContain(
      'DS0209',
    );
  });

  it('accepts a machine whose every state is reachable and can be left', () => {
    expect(codes(DOOR).filter((c) => c.startsWith('DS028'))).toEqual([]);
  });
});

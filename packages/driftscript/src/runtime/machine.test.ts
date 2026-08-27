import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearClockSource, deadlineAfter, setClockSource } from './clocks.ts';
import { createScope } from './scope.ts';
import { type TaskBody, type TaskFrame, liveTaskCount, tickTasks } from './tasks.ts';
import { type Machine, type StateDefinition, createMachine } from './machine.ts';

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

/** An entry block, compiled shape: a task that waits and then does something. */
const entry = (name: string, seconds: number, run: (machine: Machine) => void): TaskBody => ({
  name,
  start(f: TaskFrame, machine: unknown) {
    f.step = 0;
    (f as unknown as { $m: unknown }).$m = machine;
  },
  resume(f: TaskFrame) {
    if (f.step === 0) {
      f.awaiting = null;
      f.clock = 'fixed';
      f.deadline = deadlineAfter('fixed', seconds);
      f.step = 1;
      return 'waiting';
    }
    run((f as unknown as { $m: Machine }).$m);
    return 'done';
  },
});

describe('a state machine', () => {
  it('starts in the state it was given', () => {
    const scope = createScope();
    const machine = createMachine(
      'Closed',
      { Closed: { enter: null, on: {} } },
      scope,
    );

    expect(machine.current).toBe('Closed');
    machine.stop();
    scope.leave();
  });

  it('transitions on an event the current state handles', () => {
    const scope = createScope();
    const states: Record<string, StateDefinition> = {
      Closed: { enter: null, on: { Open: (m) => m.become('Open') } },
      Open: { enter: null, on: { Close: (m) => m.become('Closed') } },
    };
    const machine = createMachine('Closed', states, scope);

    machine.send('Open');
    expect(machine.current).toBe('Open');
    machine.send('Close');
    expect(machine.current).toBe('Closed');

    machine.stop();
    scope.leave();
  });

  it('ignores an event the current state does not handle', () => {
    const scope = createScope();
    const machine = createMachine(
      'Closed',
      { Closed: { enter: null, on: { Open: (m) => m.become('Closed') } } },
      scope,
    );

    expect(() => machine.send('Nothing')).not.toThrow();
    expect(machine.current).toBe('Closed');
    machine.stop();
    scope.leave();
  });

  it('carries a payload to the handler', () => {
    const scope = createScope();
    let seen: unknown;
    const machine = createMachine(
      'Closed',
      { Closed: { enter: null, on: { Open: (_m, payload) => (seen = payload) } } },
      scope,
    );

    machine.send('Open', { by: 'key' });
    expect(seen).toEqual({ by: 'key' });
    machine.stop();
    scope.leave();
  });

  it('runs a state entry block once, when the state is entered', () => {
    const scope = createScope();
    let ran = 0;
    const states: Record<string, StateDefinition> = {
      Closed: { enter: null, on: { Open: (m) => m.become('Opening') } },
      Opening: { enter: entry('Opening.enter', 0.5, () => (ran += 1)), on: {} },
    };
    const machine = createMachine('Closed', states, scope);

    machine.send('Open');
    expect(ran).toBe(0);

    steps = 30;
    tickTasks();
    expect(ran).toBe(1);

    /* And not again, however long the machine sits in the state. */
    steps = 300;
    tickTasks();
    expect(ran).toBe(1);

    machine.stop();
    scope.leave();
  });

  it('lets an entry block transition when it finishes, which is the whole point of `Opening`', () => {
    const scope = createScope();
    const states: Record<string, StateDefinition> = {
      Closed: { enter: null, on: { Open: (m) => m.become('Opening') } },
      Opening: { enter: entry('Opening.enter', 0.5, (m) => m.become('Open')), on: {} },
      Open: { enter: null, on: {} },
    };
    const machine = createMachine('Closed', states, scope);

    machine.send('Open');
    expect(machine.current).toBe('Opening');

    steps = 30;
    tickTasks();
    expect(machine.current).toBe('Open');

    machine.stop();
    scope.leave();
  });

  it('cancels a half-finished entry block when the state is left', () => {
    /*
     * A state that was two seconds into an open animation when something told it to close must not
     * go on animating — and must not arrive, later, at the `become` at the end of its entry.
     */
    const scope = createScope();
    let arrived = 0;
    const states: Record<string, StateDefinition> = {
      Opening: { enter: entry('Opening.enter', 10, () => (arrived += 1)), on: { Stop: (m) => m.become('Closed') } },
      Closed: { enter: null, on: {} },
    };
    const machine = createMachine('Opening', states, scope);

    steps = 30;
    tickTasks();
    machine.send('Stop');
    expect(machine.current).toBe('Closed');

    steps = 6000;
    tickTasks();

    expect(arrived).toBe(0);
    expect(liveTaskCount()).toBe(0);

    machine.stop();
    scope.leave();
  });

  it('refuses a state nothing declares, naming the ones it has', () => {
    const scope = createScope();
    const machine = createMachine('Closed', { Closed: { enter: null, on: {} } }, scope);

    expect(() => machine.become('Nowhere')).toThrow(/not a state of this machine/);
    expect(() => machine.become('Nowhere')).toThrow(/Closed/);

    machine.stop();
    scope.leave();
  });

  it('lets an entry block transition again the moment it starts, which `Opening` depends on', () => {
    /*
     * An entry task's first resume runs inside `spawn`, so entering A can enter B before A's entry
     * has reached its first suspend. That is deliberate and is what makes a pass-through state
     * expressible. The re-entrancy guard in `become` covers a different case — a transition
     * arriving from inside `leave` — which only a host's own scope-leave callback can produce, so
     * nothing here exercises it and the guard says as much at its declaration.
     */
    const scope = createScope();
    const immediate = (name: string, to: string): TaskBody => ({
      name,
      start(f: TaskFrame, machine: unknown) {
        f.step = 0;
        (f as unknown as { $m: unknown }).$m = machine;
      },
      resume(f: TaskFrame) {
        (f as unknown as { $m: Machine }).$m.become(to);
        return 'done';
      },
    });
    const states: Record<string, StateDefinition> = {
      A: { enter: null, on: { Go: (m) => m.become('B') } },
      B: { enter: immediate('B.enter', 'C'), on: {} },
      C: { enter: null, on: {} },
    };
    const machine = createMachine('A', states, scope);

    machine.send('Go');

    expect(machine.current).toBe('C');
    machine.stop();
    scope.leave();
  });

  it('stops, leaving the state and cancelling what it started', () => {
    const scope = createScope();
    let arrived = 0;
    const machine = createMachine(
      'Opening',
      { Opening: { enter: entry('Opening.enter', 10, () => (arrived += 1)), on: {} } },
      scope,
    );

    machine.stop();
    steps = 6000;
    tickTasks();

    expect(arrived).toBe(0);
    expect(machine.current).toBe('');
    /* And a stopped machine reacts to nothing rather than throwing at its caller. */
    expect(() => machine.send('Anything')).not.toThrow();

    scope.leave();
  });
});

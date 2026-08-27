import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearClockSource, deadlineAfter, setClockSource } from './clocks.ts';
import { disposeModule, loadModule } from './module.ts';
import { patchModule } from './hot.ts';
import {
  type Scope,
  type TaskBody,
  type TaskFrame,
  createScope,
  liveTaskCount,
  spawn,
  tickTasks,
} from './tasks.ts';

/** A loop driven by hand, so a test says what time it is rather than waiting for it. */
let steps = 0;
let frame = 0;
let wall = 0;

/** `heapUsed` is the only allocation reading available, and this tsconfig does not type Node. */
declare const process: { memoryUsage(): { heapUsed: number } };

/**
 * Every scope a test made, left afterwards.
 *
 * The scheduler's task list is module state, so a test that leaves one waiting would be counted by
 * the next — and `liveTaskCount` is exactly what one of these asserts on.
 */
const opened: Scope[] = [];
const scope = (): Scope => {
  const made = createScope();
  opened.push(made);
  return made;
};

beforeEach(() => {
  steps = 0;
  frame = 0;
  wall = 0;
  setClockSource({
    fixedSteps: () => steps,
    fixedStep: () => 1 / 60,
    frame: () => frame,
    wall: () => wall,
  });
});

afterEach(() => {
  for (const one of opened) one.leave();
  opened.length = 0;
  tickTasks();
  clearClockSource();
});

/**
 * The shape the compiler generates: a switch on an integer, with the await's deadline written onto
 * the frame the scheduler owns. Hand-written here because the runtime half has to be provable
 * before there is a parser to produce it.
 */
const waitThen = (
  name: string,
  seconds: number,
  clock: TaskFrame['clock'],
  onDone: () => void,
): TaskBody => ({
  name,
  start(f) {
    f.step = 0;
  },
  resume(f) {
    switch (f.step) {
      case 0:
        f.clock = clock;
        f.deadline = deadlineAfter(clock, seconds);
        f.step = 1;
        return 'waiting';
      default:
        onDone();
        return 'done';
    }
  },
});

describe('a task on a clock', () => {
  it('resumes on the step that reaches its deadline, and not before', () => {
    let fired = 0;
    spawn(waitThen('signal', 0.5, 'fixed', () => (fired += 1)), scope());

    /* The spawn itself runs to the first await. Nothing has fired. */
    expect(fired).toBe(0);

    for (let i = 0; i < 29; i += 1) {
      steps += 1;
      tickTasks();
    }
    /* 500ms is exactly thirty steps of a sixtieth, and twenty-nine have run. */
    expect(fired).toBe(0);

    steps += 1;
    tickTasks();
    expect(fired).toBe(1);
  });

  it('measures the wait on its own clock, so wall time passing does not resume a fixed wait', () => {
    let fired = 0;
    spawn(waitThen('signal', 0.5, 'fixed', () => (fired += 1)), scope());

    /* A stalled tab: ten seconds of real time against a simulation that never advanced. */
    wall += 10;
    frame += 10;
    tickTasks();

    expect(fired).toBe(0);
  });

  it('resumes a frame wait on frame time, which the fixed clock standing still does not stop', () => {
    /* The control the test above needs. Without it, a scheduler that resumed nothing at all would
       pass that one and be entirely broken. */
    let fired = 0;
    spawn(waitThen('animate', 0.5, 'frame', () => (fired += 1)), scope());

    frame += 0.5;
    tickTasks();

    expect(fired).toBe(1);
  });

  it('does not resume a task that has finished', () => {
    let fired = 0;
    const handle = spawn(waitThen('signal', 0, 'fixed', () => (fired += 1)), scope());

    tickTasks();
    expect(fired).toBe(1);
    expect(handle.done).toBe(true);

    tickTasks();
    tickTasks();
    expect(fired).toBe(1);
  });
});

describe('cancellation', () => {
  it('never resumes a task cancelled mid-await', () => {
    let fired = 0;
    const handle = spawn(waitThen('signal', 0.5, 'fixed', () => (fired += 1)), scope());

    handle.cancel();
    steps += 600;
    tickTasks();

    expect(fired).toBe(0);
    expect(handle.done).toBe(true);
  });

  it('cancels every task a scope owns when the scope is left', () => {
    let fired = 0;
    const owner = scope();
    owner.enter();
    const a = spawn(waitThen('a', 0.5, 'fixed', () => (fired += 1)), owner);
    const b = spawn(waitThen('b', 0.5, 'fixed', () => (fired += 1)), owner);

    owner.leave();
    steps += 600;
    tickTasks();

    expect(fired).toBe(0);
    expect(a.done).toBe(true);
    expect(b.done).toBe(true);
  });

  it('leaves a task in another scope running, so cancellation is ownership rather than a flush', () => {
    /* The control the cancel-on-leave test needs: a `leave()` that cancelled everything alive
       would pass that test and be wrong. */
    let outer = 0;
    const doomed = scope();
    const kept = scope();
    spawn(waitThen('doomed', 0.5, 'fixed', () => undefined), doomed);
    spawn(waitThen('kept', 0.5, 'fixed', () => (outer += 1)), kept);

    doomed.leave();
    steps += 600;
    tickTasks();

    expect(outer).toBe(1);
  });

  it('refuses a task spawned into a scope that has been left', () => {
    /* Accepting it would produce a task nothing owns, inside the mechanism that exists to stop
       exactly that — and it would be cancelled by nothing, ever. */
    const owner = scope();
    owner.leave();

    expect(() => spawn(waitThen('detached', 1, 'fixed', () => undefined), owner)).toThrow(
      /scope that has been left/,
    );
  });

  it('accepts one again once the scope is re-entered for a new scene', () => {
    const owner = scope();
    owner.leave();
    owner.enter();

    expect(() => spawn(waitThen('again', 1, 'fixed', () => undefined), owner)).not.toThrow();
  });

  it('forgets a cancelled task rather than carrying it, so a scene remounted does not accumulate', () => {
    const owner = scope();
    for (let i = 0; i < 100; i += 1) {
      spawn(waitThen(`t${i}`, 10, 'fixed', () => undefined), owner);
    }
    expect(liveTaskCount()).toBe(100);

    owner.leave();
    tickTasks();

    expect(liveTaskCount()).toBe(0);
  });
});

describe('nested scopes', () => {
  it('leaves a scope opened inside another when the outer one is left', () => {
    let inner = 0;
    const outer = scope();
    const nested = createScope(outer);
    spawn(waitThen('nested', 1, 'fixed', () => (inner += 1)), nested);

    outer.leave();
    steps += 600;
    tickTasks();

    expect(inner).toBe(0);
  });

  it('cancels the children a task opened when the task itself is cancelled', () => {
    /*
     * A task that opened a scope and was killed mid-way never runs the leave at the end of that
     * block, so the tasks inside it would be owned by something nobody can reach. Every task gets
     * a scope of its own for exactly this, and it is left however the task ends.
     */
    let child = 0;
    let opened: Scope | undefined;
    const owner = scope();
    const handle = spawn(
      {
        name: 'parent',
        start(f) {
          f.step = 0;
        },
        resume(f) {
          if (f.step === 0) {
            opened = createScope(f.owner);
            spawn(waitThen('child', 1, 'fixed', () => (child += 1)), opened);
            f.clock = 'fixed';
            f.deadline = deadlineAfter('fixed', 10);
            f.step = 1;
            return 'waiting';
          }
          return 'done';
        },
      },
      owner,
    );

    expect(opened).toBeDefined();
    handle.cancel();
    steps += 600;
    tickTasks();

    expect(child).toBe(0);
    expect(liveTaskCount()).toBe(0);
  });

  it('cancels them when the task ends of its own accord too', () => {
    /* The other half, and the one a cancel-only implementation passes while leaking: a task that
       simply finished would leave its children running for the life of the loop. */
    let child = 0;
    const owner = scope();
    spawn(
      {
        name: 'brief',
        start(f) {
          f.step = 0;
        },
        resume(f) {
          spawn(waitThen('child', 1, 'fixed', () => (child += 1)), createScope(f.owner));
          return 'done';
        },
      },
      owner,
    );

    steps += 600;
    tickTasks();

    expect(child).toBe(0);
  });
});

describe('a module that owns tasks', () => {
  /** A namespace shaped like a generated module, with one task body exported under `signal`. */
  const namespace = (mark: string, log: string[]): Record<string, unknown> => ({
    __drift: { module: 'm', requires: [], shapes: {} },
    signal: {
      name: 'signal',
      start(f: TaskFrame) {
        f.step = 0;
        log.push(`start:${mark}`);
      },
      resume(f: TaskFrame) {
        switch (f.step) {
          case 0:
            f.clock = 'fixed';
            f.deadline = deadlineAfter('fixed', 1);
            f.step = 1;
            return 'waiting';
          default:
            log.push(`done:${mark}`);
            return 'done';
        }
      },
    } satisfies TaskBody,
  });

  const bodyOf = (module: { exports: Record<string, unknown> }): TaskBody =>
    module.exports.signal as TaskBody;

  it('cancels a task it owns when the module is disposed', () => {
    /* The task holds the module's code. Tearing the module down and leaving the task running
       would leave live work calling into exports that have been emptied. */
    const log: string[] = [];
    const module = loadModule(namespace('v1', log));
    const handle = spawn(bodyOf(module), module.scope);

    disposeModule(module);
    steps += 600;
    tickTasks();

    expect(handle.done).toBe(true);
    expect(log).toEqual(['start:v1']);
  });

  it('keeps a running task on its resume point across a hot reload', () => {
    /*
     * The frame belongs to the scheduler and the code belongs to the module, so a patch replaces
     * only the second. A task that restarted would run `start` again and log it — which is exactly
     * what makes this assertion able to fail.
     */
    const log: string[] = [];
    const module = loadModule(namespace('v1', log));
    spawn(bodyOf(module), module.scope);
    expect(log).toEqual(['start:v1']);

    expect(patchModule(module, namespace('v2', log))).toEqual({ patched: true });

    steps += 60;
    tickTasks();

    /* The new code ran, from the resume point the old code had reached. */
    expect(log).toEqual(['start:v1', 'done:v2']);
    module.scope.leave();
  });

  it('leaves a task on its old code when a refused patch means there is no new code', () => {
    const log: string[] = [];
    const module = loadModule({
      ...namespace('v1', log),
      __drift: { module: 'm', requires: [], shapes: { Pulse: ['phase'] } },
    });
    spawn(bodyOf(module), module.scope);

    const refused = patchModule(module, {
      ...namespace('v2', log),
      __drift: { module: 'm', requires: [], shapes: { Pulse: ['phase', 'amplitude'] } },
    });
    expect(refused.patched).toBe(false);

    steps += 60;
    tickTasks();

    expect(log).toEqual(['start:v1', 'done:v1']);
    module.scope.leave();
  });
});

describe('the per-tick cost', () => {
  /**
   * Garbage collections that happen while `work` runs.
   *
   * **`heapUsed` cannot answer this question and was tried first.** It reads the *live* heap, so a
   * scheduler allocating one escaping object per tick and dropping it immediately shows a delta of
   * nothing — measured: a hundred thousand ticks each allocating an object and an array moved
   * `heapUsed` by under a megabyte, and the test that asserted on it passed against the very
   * perturbation it existed to catch. Collections are the signal, because garbage that is collected
   * still had to be made.
   *
   * The wait is not a delay for its own sake: entries reach an observer on a later turn, so
   * disconnecting immediately after the loop reports zero for both states.
   */
  const collectionsDuring = async (work: () => void): Promise<number> => {
    let collections = 0;
    const observer = new PerformanceObserver((list) => {
      collections += list.getEntries().length;
    });
    observer.observe({ entryTypes: ['gc'] });
    work();
    await new Promise((resolve) => setTimeout(resolve, 50));
    observer.disconnect();
    return collections;
  };

  const TICKS = 1_000_000;

  it('allocates nothing per tick once a task has started', async () => {
    /*
     * **The control is in the test**, because a collection count is a property of the machine as
     * much as of the code: a threshold that separated the two states here would be a number nobody
     * could re-derive elsewhere. So the same loop count runs against a deliberate one-object-per-
     * iteration allocation — which is what a resume built on promises and closures would do — and
     * the assertion is that the scheduler is on the other side of it.
     */
    let sink: unknown;
    spawn(waitThen('long', 1e9, 'fixed', () => undefined), scope());
    for (let i = 0; i < 1000; i += 1) tickTasks();

    /* The control runs first on purpose: it collects whatever earlier tests left in the young
       generation, so the quiet measurement is not charged for their garbage. */
    const noisy = await collectionsDuring(() => {
      for (let i = 0; i < TICKS; i += 1) sink = { step: i, waiting: [i] };
    });
    const quiet = await collectionsDuring(() => {
      for (let i = 0; i < TICKS; i += 1) tickTasks();
    });

    /*
     * Measured on this machine, stable across runs of this file alone: the control collects 26
     * times and the scheduler none. **The assertion is the separation, not either number** — a
     * stray collection can land inside the quiet window when the whole suite is running, and one
     * unreproduced failure of `toBe(0)` under full load is what put the ratio here instead. A
     * scheduler that really allocated per tick would collect about as often as the control, so the
     * quarter is not slack a regression can hide in.
     */
    expect(noisy, 'the control must separate the two states').toBeGreaterThan(3);
    expect(quiet).toBeLessThan(noisy / 4);
    expect(sink).not.toBe(undefined);
  });
});

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
  /**
   * The ABI a compiler emits for the body below: two blocks, the second reached by the suspension.
   *
   * Spelled out here because this fixture is hand-written rather than compiled — the compiled side
   * is covered in `compiler/emit/task.test.ts`. What matters is that a patch has *both* versions'
   * answers to compare, which is what a live task's rebind now requires.
   */
  const ABI = { fields: [], conts: ['entry', '0'] };

  /** A namespace shaped like a generated module, with one task body exported under `signal`. */
  const namespace = (
    mark: string,
    log: string[],
    abi: unknown = ABI,
  ): Record<string, unknown> => ({
    __drift: { module: 'm', requires: [], shapes: {}, tasks: { signal: abi } },
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

describe('a hot patch across a live task', () => {
  /*
   * **A suspended task is state, and this is the matrix that says so.**
   *
   * The record path has had the right shape for a while: compare, plan, refuse by name, mutate
   * only once the whole patch is known to be safe. A live task frame is state in exactly the same
   * sense — the task's locals and an integer selecting where it resumes — and it was being handed
   * to new code on the strength of the exported *name* alone.
   *
   * Every row below has a stated outcome. There is no fourth category: a patch either preserves the
   * task, migrates it, or is refused atomically.
   */
  /** A module namespace with one live task, its ABI given per version. */
  const versionOf = (abi: {
    fields: (readonly [string, string])[];
    conts: (string | null)[];
  }): Record<string, unknown> => ({
    __drift: { module: 'm', requires: [], shapes: {}, tasks: { signal: abi } },
    signal: {
      name: 'signal',
      start(f: TaskFrame) {
        f.step = 0;
      },
      resume(f: TaskFrame) {
        if (f.step === 0) {
          f.clock = 'fixed';
          f.deadline = deadlineAfter('fixed', 1);
          f.step = 1;
          return 'waiting';
        }
        return 'done';
      },
    } satisfies TaskBody,
  });

  const V1 = {
    fields: [['$phase', 'f32']] as (readonly [string, string])[],
    conts: ['entry', '0'] as (string | null)[],
  };

  /** Start a module with `V1` live and suspended, then patch it with `next`. */
  const patchWith = (next: Record<string, unknown>) => {
    const module = loadModule(versionOf(V1));
    spawn(module.exports.signal as TaskBody, module.scope);
    return { module, result: patchModule(module, next) };
  };

  it('preserves the task when the body changed but the frame and the resume points did not', () => {
    /* The common edit: change what happens after the `await`. Every id survives, so the task keeps
       the seconds it has already waited. */
    const { module, result } = patchWith(versionOf(V1));
    expect(result).toEqual({ patched: true });
    module.scope.leave();
  });

  it('migrates a frame that gained a local, initialising it the way `start` would', () => {
    const { module, result } = patchWith(
      versionOf({ fields: [...V1.fields, ['$extra', 'f32']], conts: [...V1.conts] }),
    );
    expect(result).toEqual({ patched: true });
    module.scope.leave();
  });

  it('migrates a frame that lost a local, so nothing reads a value from a dead version', () => {
    const { module, result } = patchWith(versionOf({ fields: [], conts: [...V1.conts] }));
    expect(result).toEqual({ patched: true });
    module.scope.leave();
  });

  it('migrates a reordered frame, because a field is matched by name and not by position', () => {
    const { module, result } = patchWith(
      versionOf({
        fields: [
          ['$extra', 'f32'],
          ['$phase', 'f32'],
        ],
        conts: [...V1.conts],
      }),
    );
    expect(result).toEqual({ patched: true });
    module.scope.leave();
  });

  it('follows a resume point that moved to a different block index', () => {
    /*
     * Control flow around a suspension can change the block *numbering* without changing where the
     * task suspends — an `if` that started being cut, say. The shape is the same, so the patch is
     * accepted and the frame's `step` is carried onto the index the new version put it at. The
     * integer alone could not have expressed either half of that.
     */
    const { module, result } = patchWith(
      versionOf({ fields: [...V1.fields], conts: ['entry', null, '0'] }),
    );
    expect(result).toEqual({ patched: true });
    module.scope.leave();
  });

  it('refuses an appended `await`, because an id cannot tell append from insert', () => {
    /*
     * `conts` describes the *shape* of a task's suspensions and deliberately not their content, so
     * that changing a duration or the code around an `await` keeps every id — which is what hot
     * reload is for. The price is that adding a suspension at the end and adding one at the start
     * produce the same set of ids, and in the second case every id names a different `await`. Both
     * are refused rather than one being guessed at.
     */
    const { module, result } = patchWith(
      versionOf({ fields: [...V1.fields], conts: ['entry', '0', '1'] }),
    );
    expect(result.patched).toBe(false);
    module.scope.leave();
  });

  it('refuses when a live local changed type', () => {
    /* The record path's own answer: a `phase` that was an `f32` and is now a `String` has no value
       that is both. */
    const { module, result } = patchWith(
      versionOf({ fields: [['$phase', 'string']], conts: [...V1.conts] }),
    );
    expect(result.patched).toBe(false);
    expect((result as { reason: string }).reason).toContain('$phase');
    expect((result as { reason: string }).reason).toContain('f32');
    module.scope.leave();
  });

  it('refuses when the resume point the frame names is gone', () => {
    /*
     * Inserting an `await` *before* the current one renumbers every continuation after it. The old
     * `step` would have selected a resume point belonging to different source — and the task would
     * have gone on running, at the wrong place, for ever.
     */
    const { module, result } = patchWith(
      versionOf({ fields: [...V1.fields], conts: ['entry', '1'] }),
    );
    expect(result.patched).toBe(false);
    expect((result as { reason: string }).reason).toContain('`signal`');
    expect((result as { reason: string }).reason).toContain('await');
    module.scope.leave();
  });

  it('refuses when either version carries no ABI, rather than guessing', () => {
    const module = loadModule(versionOf(V1));
    spawn(module.exports.signal as TaskBody, module.scope);
    const result = patchModule(module, {
      __drift: { module: 'm', requires: [], shapes: {} },
      signal: (versionOf(V1) as { signal: TaskBody }).signal,
    });
    expect(result.patched).toBe(false);
    expect((result as { reason: string }).reason).toContain('Recompile');
    module.scope.leave();
  });

  it('rebinds nothing when one of several live tasks is incompatible', () => {
    /*
     * Atomicity, which is the property the record path already had and this one did not. A patch
     * refused on the second task must leave the first exactly as it was — on the version its frame
     * belongs to, not on a mixture no source file describes.
     */
    const before = liveTaskCount();
    const module = loadModule(versionOf(V1));
    const first = module.exports.signal as TaskBody;
    spawn(first, module.scope);
    spawn(first, module.scope);
    expect(liveTaskCount() - before).toBe(2);

    const result = patchModule(
      module,
      versionOf({ fields: [['$phase', 'string']], conts: [...V1.conts] }),
    );
    expect(result.patched).toBe(false);

    /* Both are still running the code their frames belong to. */
    expect(liveTaskCount() - before).toBe(2);
    expect(module.exports.signal).toBe(first);
    module.scope.leave();
  });

  it('leaves a task whose name is gone on its old code rather than cancelling it', () => {
    /* Killing live work because a name moved would make renaming a task a scene reset. */
    const before = liveTaskCount();
    const module = loadModule(versionOf(V1));
    spawn(module.exports.signal as TaskBody, module.scope);
    const result = patchModule(module, {
      __drift: { module: 'm', requires: [], shapes: {}, tasks: {} },
    });
    expect(result).toEqual({ patched: true });
    expect(liveTaskCount() - before).toBe(1);
    module.scope.leave();
  });

  it('says nothing about a task that is not running', () => {
    /* An ABI change only has to be answered for a frame that exists. A module whose tasks have all
       finished may be edited freely, which is most edits. */
    const module = loadModule(versionOf(V1));
    const result = patchModule(
      module,
      versionOf({ fields: [['$phase', 'string']], conts: ['entry'] }),
    );
    expect(result).toEqual({ patched: true });
    module.scope.leave();
  });
});

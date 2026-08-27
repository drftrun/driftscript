import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';
import { createRegistry, defineCapability } from '../../registry/capability.ts';
import { clearClockSource, setClockSource } from '../../runtime/clocks.ts';
import { disposeModule, loadModule } from '../../runtime/module.ts';
import { type TaskBody, liveTaskCount, spawn, tickTasks } from '../../runtime/tasks.ts';

let steps = 0;
let frame = 0;

beforeEach(() => {
  steps = 0;
  frame = 0;
  setClockSource({
    fixedSteps: () => steps,
    fixedStep: () => 1 / 60,
    frame: () => frame,
    wall: () => 0,
  });
});

afterEach(() => {
  clearClockSource();
});

/**
 * One capability that takes numbers, so a task's progress is observable without a handle type.
 *
 * Built here rather than imported from the engine bindings, because this package must not reach the
 * engine — the same reason `check/effects.test.ts` builds its own.
 */
const registry = () => {
  const r = createRegistry();
  r.add(
    defineCapability({
      module: 'drift/events',
      name: 'mark',
      signature: 'fn(value: f32) -> void',
      params: [{ name: 'value', type: 'f32' }],
      returns: 'void',
      effects: ['pure'],
      deterministic: true,
      doc: 'Record that a task reached a point, carrying a number.',
      implementation: 'test.mark',
    }),
  );
  return r;
};

const compile = (source: string) => {
  const { code, diagnostics } = compileDriftScript(source, {
    filename: 't.drs',
    host: singleFileHost(),
    registry: registry(),
    mode: 'development',
  });
  expect(diagnostics).toEqual([]);
  return code;
};

const load = async (source: string) => {
  const code = compile(source);
  const namespace = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${btoa(code)}`
  )) as Record<string, unknown>;
  return loadModule(namespace);
};

/** Give a loaded module the one capability above, and hand back what it recorded. */
const bind = (module: { exports: Record<string, unknown> }): number[] => {
  const marks: number[] = [];
  (module.exports.__bind as (host: Record<string, unknown>) => void)({
    'drift/events': { mark: (value: number) => marks.push(value) },
  });
  return marks;
};

describe('a compiled task', () => {
  it('is a switch on an integer, with no promise anywhere in it', () => {
    /*
     * The property the whole design rests on. A promise chain would allocate a closure and a
     * promise per await, per task, per resume — and a scheduler running once per simulation step
     * turns that into the per-frame allocation the engine forbids.
     */
    const code = compile('task settle() {\n    await fixedTime(500ms)\n}\n');

    expect(code).toContain('switch ($f.step)');
    expect(code).not.toMatch(/\basync\b/);
    expect(code).not.toMatch(/\bPromise\b/);
    /* The only `await` left is the word inside the diagnostic-free source map, never in code. */
    expect(code).not.toMatch(/^\s*await /m);
  });

  it('runs to its first suspend at spawn and resumes on the step that reaches the deadline', async () => {
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task settle() {\n' +
        '    await fixedTime(500ms)\n' +
        '    events.mark(1)\n' +
        '}\n',
    );

    const marks = bind(module);

    spawn(module.exports.settle as TaskBody, module.scope);
    expect(marks).toEqual([]);

    steps = 29;
    tickTasks();
    expect(marks).toEqual([]);

    /* 500ms is exactly thirty steps of a sixtieth. */
    steps = 30;
    tickTasks();
    expect(marks).toEqual([1]);

    module.scope.leave();
  });

  it('keeps a local across a suspend, because it lives on the frame', async () => {
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task settle() {\n' +
        '    var counted = 7\n' +
        '    await fixedTime(500ms)\n' +
        '    counted += 1\n' +
        '    events.mark(counted)\n' +
        '}\n',
    );

    const marks = bind(module);

    spawn(module.exports.settle as TaskBody, module.scope);
    steps = 30;
    tickTasks();

    expect(marks).toEqual([8]);
    module.scope.leave();
  });

  it('loops, so an await inside a `while` resumes the head rather than restarting the task', async () => {
    /* The back-edge is the thing a linear cut cannot express, and the reason the body is lowered
       to blocks rather than to a sequence of resume points. */
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task beat() {\n' +
        '    var n = 0\n' +
        '    while n < 3 {\n' +
        '        await fixedTime(100ms)\n' +
        '        n += 1\n' +
        '        events.mark(n)\n' +
        '    }\n' +
        '}\n',
    );

    const ticks = bind(module);

    const handle = spawn(module.exports.beat as TaskBody, module.scope);

    /* 100ms is six steps of a sixtieth, so three beats land on 6, 12 and 18. */
    for (let step = 1; step <= 20; step += 1) {
      steps = step;
      tickTasks();
    }

    expect(ticks).toEqual([1, 2, 3]);
    expect(handle.done).toBe(true);
    module.scope.leave();
  });

  it('takes its arguments through the frame, so a spawn can supply them', async () => {
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task hold(seconds: f32) {\n' +
        '    await fixedTime(seconds)\n' +
        '    events.mark(9)\n' +
        '}\n',
    );

    const held = bind(module);

    spawn(module.exports.hold as TaskBody, module.scope, 1);

    steps = 59;
    tickTasks();
    expect(held).toEqual([]);

    steps = 60;
    tickTasks();
    expect(held).toEqual([9]);

    module.scope.leave();
  });

  it('spawns from an ordinary function into the module scope, so disposal cancels it', async () => {
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task settle() {\n' +
        '    await fixedTime(500ms)\n' +
        '    events.mark(1)\n' +
        '}\n' +
        '\n' +
        'fn begin() {\n' +
        '    spawn settle()\n' +
        '}\n',
    );

    const marks = bind(module);
    (module.exports.begin as () => void)();

    disposeModule(module);
    steps = 600;
    tickTasks();

    expect(marks).toEqual([]);
  });

  it('cancels what a `scope` block started when the block ends', async () => {
    /*
     * The whole point of the form. `slow` waits ten seconds and would still be waiting; the scope
     * closing half a second in is what stops it, without the script remembering to.
     */
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task slow() {\n' +
        '    await fixedTime(10s)\n' +
        '    events.mark(99)\n' +
        '}\n' +
        '\n' +
        'task run() {\n' +
        '    scope effect {\n' +
        '        spawn slow()\n' +
        '        await fixedTime(500ms)\n' +
        '    }\n' +
        '    events.mark(1)\n' +
        '}\n',
    );

    const marks = bind(module);
    spawn(module.exports.run as TaskBody, module.scope);

    for (let step = 1; step <= 700; step += 1) {
      steps = step;
      tickTasks();
    }

    /* The outer task finished; the inner one was cancelled before its ten seconds were up. */
    expect(marks).toEqual([1]);
    module.scope.leave();
  });

  it('owns a spawn outside any `scope` block with the task itself', async () => {
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task slow() {\n' +
        '    await fixedTime(10s)\n' +
        '    events.mark(99)\n' +
        '}\n' +
        '\n' +
        'task run() {\n' +
        '    spawn slow()\n' +
        '    await fixedTime(500ms)\n' +
        '}\n',
    );

    const marks = bind(module);
    spawn(module.exports.run as TaskBody, module.scope);

    for (let step = 1; step <= 700; step += 1) {
      steps = step;
      tickTasks();
    }

    /* `run` finished at step 30 and took `slow` with it, because a task owns what it started. */
    expect(marks).toEqual([]);
    module.scope.leave();
  });

  it('waits for another task to finish before going on', async () => {
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task inner() {\n' +
        '    await fixedTime(500ms)\n' +
        '    events.mark(1)\n' +
        '}\n' +
        '\n' +
        'task outer() {\n' +
        '    await inner()\n' +
        '    events.mark(2)\n' +
        '}\n',
    );

    const marks = bind(module);
    spawn(module.exports.outer as TaskBody, module.scope);

    steps = 29;
    tickTasks();
    expect(marks).toEqual([]);

    steps = 30;
    tickTasks();
    /* The inner task finished on this tick. The outer one resumes on the next. */
    expect(marks).toEqual([1]);

    steps = 31;
    tickTasks();
    expect(marks).toEqual([1, 2]);

    module.scope.leave();
  });

  it('passes arguments to a task it awaits', async () => {
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task hold(seconds: f32) {\n' +
        '    await fixedTime(seconds)\n' +
        '}\n' +
        '\n' +
        'task outer() {\n' +
        '    await hold(1)\n' +
        '    events.mark(3)\n' +
        '}\n',
    );

    const marks = bind(module);
    spawn(module.exports.outer as TaskBody, module.scope);

    for (let step = 1; step <= 59; step += 1) {
      steps = step;
      tickTasks();
    }
    expect(marks).toEqual([]);

    for (let step = 60; step <= 62; step += 1) {
      steps = step;
      tickTasks();
    }
    expect(marks).toEqual([3]);

    module.scope.leave();
  });

  it('resumes a waiter whose awaited task was cancelled, rather than stranding it', async () => {
    /* The alternative is a task suspended forever on work that will never complete, and a scope
       leaving would then have to hunt down waiters as well as owners. */
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task never() {\n' +
        '    await fixedTime(1000s)\n' +
        '}\n' +
        '\n' +
        'task outer() {\n' +
        '    scope work {\n' +
        '        await never()\n' +
        '    }\n' +
        '    events.mark(4)\n' +
        '}\n',
    );

    const marks = bind(module);
    const handle = spawn(module.exports.outer as TaskBody, module.scope);
    expect(handle.done).toBe(false);

    module.scope.leave();
    steps = 10;
    tickTasks();

    /* The outer task was cancelled with the scope too, so nothing is marked — but nothing is left
       waiting either. */
    expect(marks).toEqual([]);
    expect(handle.done).toBe(true);
    expect(liveTaskCount()).toBe(0);
  });

  it('is cancelled with the module that declared it', async () => {
    const module = await load('task settle() {\n    await fixedTime(500ms)\n}\n');
    const handle = spawn(module.exports.settle as TaskBody, module.scope);

    module.scope.leave();
    steps = 600;
    tickTasks();

    expect(handle.done).toBe(true);
  });
});

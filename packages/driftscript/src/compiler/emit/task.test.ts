import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';
import { createRegistry, defineCapability } from '../../registry/capability.ts';
import { clearClockSource, setClockSource } from '../../runtime/clocks.ts';
import { bindHost, disposeModule, loadModule } from '../../runtime/module.ts';
import { type TaskBody, liveTaskCount, spawn, tickTasks } from '../../runtime/tasks.ts';
import { patchModule } from '../../runtime/hot.ts';

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

describe('`break` and `continue` inside a task', () => {
  /**
   * The hazard these tests exist for is silent, and it is not the jump itself.
   *
   * A task body becomes a `switch` inside a `for (;;)`, so a bare JavaScript `break` in that
   * position breaks the **switch**: the state machine falls out of its dispatch and the task ends,
   * with nothing thrown and nothing logged. So an `if` holding a jump has to be cut into blocks
   * even when it holds no `await` — which is why `blocksOf` cuts on anything other than suspension
   * at all.
   */
  it('emits no bare `break`, because that would break the switch and end the task', () => {
    const code = compile(
      'task walk() {\n' +
        '    var n = 0\n' +
        '    while n < 3 {\n' +
        '        await fixedTime(500ms)\n' +
        '        n += 1\n' +
        '        if n < 2 {\n' +
        '            continue\n' +
        '        }\n' +
        '        break\n' +
        '    }\n' +
        '}\n',
    );
    /* Every exit from a block is a step assignment and a `continue` of the dispatch loop. A
       `break;` anywhere in a task body is the bug this is here to catch. */
    expect(code).toContain('switch ($f.step)');
    expect(/^\s*break;\s*$/m.test(code)).toBe(false);
  });

  it('leaves the loop on `break`, across a suspend', async () => {
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task walk() {\n' +
        '    var n = 0\n' +
        '    while n < 10 {\n' +
        '        await fixedTime(500ms)\n' +
        '        n += 1\n' +
        '        events.mark(n)\n' +
        '        if n == 2 {\n' +
        '            break\n' +
        '        }\n' +
        '    }\n' +
        '    events.mark(99)\n' +
        '}\n',
    );
    const marks = bind(module);
    spawn(module.exports.walk as TaskBody, module.scope);

    steps = 30;
    tickTasks();
    expect(marks).toEqual([1]);

    /* The second turn hits the `break`, so the loop is left and the statement after it runs — the
       loop condition would have allowed eight more turns. */
    steps = 60;
    tickTasks();
    expect(marks).toEqual([1, 2, 99]);
    expect(liveTaskCount()).toBe(0);
  });

  it('skips the rest of the turn on `continue`, and keeps looping', async () => {
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task walk() {\n' +
        '    var n = 0\n' +
        '    while n < 3 {\n' +
        '        await fixedTime(500ms)\n' +
        '        n += 1\n' +
        '        if n < 3 {\n' +
        '            continue\n' +
        '        }\n' +
        '        events.mark(n)\n' +
        '    }\n' +
        '}\n',
    );
    const marks = bind(module);
    spawn(module.exports.walk as TaskBody, module.scope);

    /* Three turns, and only the last one reaches the mark: the first two jumped back to the head
       before it. A `continue` that had broken the switch would have ended the task at the first. */
    steps = 30;
    tickTasks();
    expect(marks).toEqual([]);
    steps = 60;
    tickTasks();
    expect(marks).toEqual([]);
    steps = 90;
    tickTasks();
    expect(marks).toEqual([3]);
  });
});

describe('a `for … in` that suspends', () => {
  /*
   * **A list loop may now `await`, and before this release it crashed the compiler.**
   *
   * `containsAwait` did not descend into `forList`, so the body was never cut, the suspend reached
   * the ordinary statement emitter, and the compiler threw a bare internal `Error` — at a program
   * that is the obvious way to write "do this to each of them, a beat apart".
   *
   * The loop's list and index live on the frame for the same reason every other task local does:
   * the body returns between one element and the next, and a `const` would not survive it.
   */
  it('walks one element per resume, keeping its place across the suspension', async () => {
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task each(xs: List<f32>) {\n' +
        '    for x in xs {\n' +
        '        events.mark(x)\n' +
        '        await fixedTime(500ms)\n' +
        '    }\n' +
        '    events.mark(99)\n' +
        '}\n',
    );

    const marks = bind(module);

    spawn(module.exports.each as TaskBody, module.scope, [1, 2, 3]);
    expect(marks).toEqual([1]);

    steps = 30;
    tickTasks();
    expect(marks).toEqual([1, 2]);

    steps = 60;
    tickTasks();
    expect(marks).toEqual([1, 2, 3]);

    steps = 90;
    tickTasks();
    expect(marks).toEqual([1, 2, 3, 99]);
    expect(liveTaskCount()).toBe(0);

    module.scope.leave();
  });

  it('reads the subject once, not once per element', () => {
    /* A subject that is a call would otherwise run per turn. It is read into the frame at the
       point the loop opens, which is also what makes the walk stable if the list is replaced. */
    const code = compile(
      'task each(xs: List<f32>) {\n' +
        '    for x in xs {\n' +
        '        await fixedTime(1s)\n' +
        '    }\n' +
        '}\n',
    );
    /* Once in the loop's own opening statement. `start` also names the field, initialising it to
       `undefined` the way it does every frame local, which is not a read of the subject. */
    expect(code.match(/\$f\.\$\$l0 = \$f\.\$xs;/g)).toHaveLength(1);
  });

  it('sends a `continue` to the increment, not to the head', async () => {
    /*
     * The failure this guards against is silent and total: a `continue` that jumped to the head
     * would re-bind the same element for ever, and a task in that state is alive, resuming, and
     * making no progress.
     */
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task each(xs: List<f32>) {\n' +
        '    for x in xs {\n' +
        '        await fixedTime(500ms)\n' +
        '        if x > 1 {\n' +
        '            continue\n' +
        '        }\n' +
        '        events.mark(x)\n' +
        '    }\n' +
        '    events.mark(99)\n' +
        '}\n',
    );

    const marks = bind(module);
    spawn(module.exports.each as TaskBody, module.scope, [1, 2]);

    steps = 30;
    tickTasks();
    expect(marks).toEqual([1]);

    steps = 60;
    tickTasks();
    expect(marks).toEqual([1, 99]);
    expect(liveTaskCount()).toBe(0);

    module.scope.leave();
  });

  it('sends a `break` past the rest of the list', async () => {
    const module = await load(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task each(xs: List<f32>) {\n' +
        '    for x in xs {\n' +
        '        await fixedTime(500ms)\n' +
        '        if x > 1 {\n' +
        '            break\n' +
        '        }\n' +
        '        events.mark(x)\n' +
        '    }\n' +
        '    events.mark(99)\n' +
        '}\n',
    );

    const marks = bind(module);
    spawn(module.exports.each as TaskBody, module.scope, [1, 2, 3]);

    steps = 30;
    tickTasks();
    expect(marks).toEqual([1]);

    steps = 60;
    tickTasks();
    expect(marks).toEqual([1, 99]);

    module.scope.leave();
  });

  it('is left as an ordinary JavaScript loop when nothing in it suspends', () => {
    /* The rule the whole file follows: only control flow containing an `await` is cut, because
       splitting the rest would buy nothing and cost every reader of the output. */
    const code = compile(
      'task each(xs: List<f32>) {\n' +
        '    for x in xs {\n' +
        '        let y = x + 1\n' +
        '    }\n' +
        '    await fixedTime(1s)\n' +
        '}\n',
    );
    expect(code).toContain('for (let $n0 = 0;');
    expect(code).not.toContain('$f.$$n0');
  });

  it('still refuses an `await` in a query loop, however deeply the loop is nested', () => {
    const { diagnostics } = compileDriftScript(
      'component Meta { x: f64 = 0 }\n' +
        '\n' +
        'task each(world: World, xs: List<f32>) {\n' +
        '    for e in query<Meta>() {\n' +
        '        for x in xs {\n' +
        '            await fixedTime(1s)\n' +
        '        }\n' +
        '    }\n' +
        '}\n',
      { filename: 't.drs', host: singleFileHost(), registry: registry(), mode: 'development' },
    );
    expect(diagnostics.map((d) => d.code)).toContain('DS0289');
  });
});

describe('a hot patch across a task compiled from real source', () => {
  /*
   * The matrix in `runtime/tasks.test.ts` drives hand-written ABIs, which is what makes it able to
   * cover cases the compiler cannot be talked into emitting. This is the other half: the compiler
   * actually emits an ABI that distinguishes the two edits that matter, from two real source files.
   */
  const patch = async (before: string, after: string) => {
    const module = await load(before);
    /* Through `bindHost` rather than by calling `__bind` directly, because that is what records the
       host for `rebindHost` — a patched module has new closures and has to be bound again. */
    const marks: number[] = [];
    bindHost(module, { 'drift/events': { mark: (value: number) => marks.push(value) } });
    spawn(module.exports.settle as TaskBody, module.scope);

    const namespace = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(compile(after))}`
    )) as Record<string, unknown>;
    return { module, marks, result: patchModule(module, namespace) };
  };

  const V1 =
    'import { mark } from "drift/events"\n' +
    '\n' +
    'task settle() {\n' +
    '    await fixedTime(500ms)\n' +
    '    events.mark(1)\n' +
    '}\n';

  it('accepts an edit after the resume point, and the new code runs from it', async () => {
    const { module, marks, result } = await patch(
      V1,
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task settle() {\n' +
        '    await fixedTime(500ms)\n' +
        '    events.mark(2)\n' +
        '}\n',
    );
    expect(result).toEqual({ patched: true });

    steps = 30;
    tickTasks();
    /* The patched code ran, from the point the old code had reached — not from the beginning. */
    expect(marks).toEqual([2]);
    module.scope.leave();
  });

  it('refuses an edit that inserts an `await` before the resume point', async () => {
    /*
     * The failure this exists for. Block numbering is positional, so the old frame's `step` would
     * have selected the continuation of the *new* first await — and the task would have carried on
     * running, at the wrong place, silently.
     */
    const { module, marks, result } = await patch(
      V1,
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task settle() {\n' +
        '    await fixedTime(100ms)\n' +
        '    await fixedTime(500ms)\n' +
        '    events.mark(2)\n' +
        '}\n',
    );
    expect(result.patched).toBe(false);
    expect((result as { reason: string }).reason).toContain('settle');

    steps = 30;
    tickTasks();
    /* Left on the version its frame belongs to, and still correct. */
    expect(marks).toEqual([1]);
    module.scope.leave();
  });

  it('refuses an edit that changes the type of a local held across the suspension', async () => {
    const { module, result } = await patch(
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task settle() {\n' +
        '    let held = 1\n' +
        '    await fixedTime(500ms)\n' +
        '    events.mark(held)\n' +
        '}\n',
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task settle() {\n' +
        '    let held = "one"\n' +
        '    await fixedTime(500ms)\n' +
        '    events.mark(1)\n' +
        '}\n',
    );
    expect(result.patched).toBe(false);
    expect((result as { reason: string }).reason).toContain('$held');
    module.scope.leave();
  });

  it('accepts an edit that adds a local after the resume point', async () => {
    const { module, result } = await patch(
      V1,
      'import { mark } from "drift/events"\n' +
        '\n' +
        'task settle() {\n' +
        '    await fixedTime(500ms)\n' +
        '    let extra = 2\n' +
        '    events.mark(extra)\n' +
        '}\n',
    );
    expect(result).toEqual({ patched: true });
    module.scope.leave();
  });

  it('gives a suspension inside a `while` an id that survives an edit around it', async () => {
    /* A loop is where a long-running task actually sits, and its resume point is named by the
       construct rather than by a block index — so editing the body does not move it. */
    const before =
      'import { mark } from "drift/events"\n' +
      '\n' +
      'task settle() {\n' +
      '    var n = 0\n' +
      '    while n < 3 {\n' +
      '        await fixedTime(500ms)\n' +
      '        n += 1\n' +
      '        events.mark(n)\n' +
      '    }\n' +
      '}\n';
    const { module, marks, result } = await patch(
      before,
      before.replace('events.mark(n)', 'events.mark(n + 10)'),
    );
    expect(result).toEqual({ patched: true });

    steps = 30;
    tickTasks();
    expect(marks).toEqual([11]);
    module.scope.leave();
  });
});

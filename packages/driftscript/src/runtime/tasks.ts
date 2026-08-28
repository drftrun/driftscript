/**
 * Owned, cancellable tasks, and the scheduler that resumes them.
 *
 * **A task is a generated state machine, not a promise chain**, and every decision in this file
 * follows from that. A resume is a switch on an integer against a frame the scheduler already owns,
 * so a task that has started allocates nothing for the rest of its life. A promise chain allocates
 * a closure and a promise per await, per task, per resume — which in a per-tick scheduler is the
 * per-frame allocation `AGENTS.md` forbids, arrived at one `await` at a time.
 *
 * The cost is that a task's locals live on a frame the compiler lays out rather than in a closure
 * the language gives it for free, and that generated code is harder to read than the source it came
 * from. **What would make this wrong** is a host that needs to await something outside the loop —
 * a fetch, a model — which does not resume on a clock and cannot be a step count. §33 puts that
 * outside the simulation on purpose: the answer arrives as a queued command, not as a resume.
 *
 * ---
 *
 * ## Ownership is what stops a task outliving its scene
 *
 * Every task belongs to a scope, and leaving the scope cancels what has not finished. This is the
 * discipline a host otherwise runs by hand — cancel the frame, unbind the controls, dispose the
 * handle — and the whole point of putting it in the language is that a script cannot forget it.
 *
 * A scope that has been left **refuses** a new task rather than accepting a detached one. That is
 * the failure the ownership exists to prevent, and accepting it silently would reintroduce it
 * inside the mechanism meant to remove it.
 */
import { type Clock, readClock } from './clocks.ts';
import { type Scope, createScope, hasLeft, observeScopeLeave } from './scope.ts';

/* Re-exported so a consumer reaches ownership through the runtime barrel rather than having to
   know which file it lives in. `scope.ts` is where the semantics are. */
export type { Scope } from './scope.ts';
export { createScope } from './scope.ts';

/** What a resume reports: the task is waiting on its clock, or it has run to the end. */
export type TaskStep = 'waiting' | 'done';

/**
 * The mutable frame of one running task.
 *
 * Allocated once, at spawn, and mutated in place afterwards. Generated code extends this with the
 * locals it carries across a resume, which is why the fields are plain and writable rather than
 * hidden behind accessors.
 */
export interface TaskFrame {
  /** Which resume point. The integer a generated `switch` dispatches on. */
  step: number;
  /**
   * The scope this task's own children belong to.
   *
   * Every task gets one, created under the scope it was spawned into and left when it ends however
   * it ends. Without it a `scope` block the task opened would outlive a task that returned out of
   * the middle of it, and the tasks inside would be owned by something nobody can reach — which is
   * the detached work ownership exists to prevent, one level down.
   */
  readonly owner: Scope;
  /** Which clock the current await is measured on. */
  clock: Clock;
  /**
   * What `readClock(clock)` must reach for the current await to be over.
   *
   * Always produced by `deadlineAfter`, and therefore always in the clock's own unit — steps on the
   * fixed clock, seconds on the other two. Nothing here needs to know which, because the only thing
   * done with it is a comparison against the same clock.
   */
  deadline: number;
  /**
   * A task this one is waiting to finish, instead of a clock.
   *
   * A separate field rather than a tagged union, because a frame is mutated in place sixty times a
   * second and re-tagging it would change its shape. `null` means the wait is a clock's, which is
   * every wait a task makes until it awaits another one.
   */
  awaiting: TaskHandle | null;
}

/**
 * One task's generated ABI: what its frame holds, and what each resume point means.
 *
 * `conts` is indexed by the integer a frame's `step` carries. `null` marks a block only a jump
 * reaches, which a suspended frame can never point at. A non-null entry is a **path**: the
 * control-flow constructs enclosing the suspension, and its ordinal among the suspensions at its
 * level — so an edit that changes arithmetic keeps every id, and an edit that inserts, removes or
 * reorders an `await` moves the ones after it, which is exactly when an old `step` has stopped
 * meaning what it meant.
 */
export interface TaskAbi {
  /** `[property, type]` per frame slot, in the spelling generated code writes. */
  readonly fields: readonly (readonly [string, string])[];
  readonly conts: readonly (string | null)[];
}

/** One task's generated code: a constructor for its frame and a switch over its resume points. */
export interface TaskBody {
  /** The exported name this body came from. What a hot patch matches a live task on. */
  readonly name: string;
  /**
   * Initialise a fresh frame, and take the task's arguments.
   *
   * The rest parameter allocates an array per spawn, which is fine: a spawn is a scene setting
   * something going, not something a tick does. Nothing in `resume` allocates, and that is the
   * path that runs sixty times a second.
   */
  start(frame: TaskFrame, ...args: readonly unknown[]): void;
  /** Advance from `frame.step`. */
  resume(frame: TaskFrame): TaskStep;
}

export interface TaskHandle {
  cancel(): void;
  readonly done: boolean;
}

interface Task {
  /** Mutable, because a hot patch swaps the code and leaves the frame where it is. */
  body: TaskBody;
  readonly frame: TaskFrame;
  readonly owner: Scope;
  live: boolean;
}

const tasks: Task[] = [];

/**
 * Whether a task has died since the last compaction.
 *
 * Compaction rewrites every live entry, which is a store per task per tick and is worth skipping on
 * the overwhelmingly common tick where nothing finished. It is a hot path: this runs once per
 * simulation step for the life of the loop.
 */
let dirty = false;

/**
 * Cancel every task a scope owned, when that scope is left.
 *
 * Registered once, at module load, rather than per scope: a scope does not know that tasks exist,
 * and this observer is the whole of what it means for a task to belong to one.
 */
observeScopeLeave((scope) => {
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (task !== undefined && task.live && task.owner === scope) {
      task.live = false;
      task.frame.owner.leave();
      dirty = true;
    }
  }
});

/**
 * Start a task, running it up to its first await.
 *
 * **Eagerly**, because a task's first segment is the part that decides what it is waiting for, and
 * a spawn that deferred it would leave the task waiting on a frame nobody had filled in — resuming
 * a step late, and one step later again for every await after that.
 */
export function spawn(body: TaskBody, owner: Scope, ...args: readonly unknown[]): TaskHandle {
  if (hasLeft(owner)) {
    throw new Error(
      `\`${body.name}\` cannot be spawned into a scope that has been left. A task in a scope ` +
        'nothing owns is exactly the detached work a scope exists to prevent; enter the scope ' +
        'again if it is being reused for a new scene.',
    );
  }

  /* The task's own scope, under the one it was spawned into: what a `scope` block inside it opens
     against, and what is left when it ends however it ends. */
  const frame: TaskFrame = {
    step: 0,
    clock: 'fixed',
    deadline: 0,
    awaiting: null,
    owner: createScope(owner),
  };
  body.start(frame, ...args);

  const task: Task = { body, frame, owner, live: true };
  tasks.push(task);

  const handle: TaskHandle = {
    cancel(): void {
      if (!task.live) return;
      task.live = false;
      task.frame.owner.leave();
      dirty = true;
    },
    get done(): boolean {
      return !task.live;
    },
  };

  if (body.resume(frame) === 'done') {
    task.live = false;
    frame.owner.leave();
    dirty = true;
  }
  return handle;
}

/**
 * Resume every task whose clock has reached its deadline.
 *
 * A host calls this from its loop. The two passes are deliberate: a task spawned by another task's
 * resume joins `tasks` during the first pass and must not be resumed again in the same tick, so the
 * pass is bounded by the count it started with. Compaction then runs over the whole array, so a
 * newcomer is kept.
 */
export function tickTasks(): void {
  const count = tasks.length;
  for (let i = 0; i < count; i += 1) {
    const task = tasks[i];
    if (task === undefined || !task.live) continue;
    if (!isDue(task.frame)) continue;
    if (task.body.resume(task.frame) === 'done') {
      task.live = false;
      task.frame.owner.leave();
      dirty = true;
    }
  }

  if (!dirty) return;
  let write = 0;
  for (let read = 0; read < tasks.length; read += 1) {
    const task = tasks[read];
    if (task === undefined || !task.live) continue;
    tasks[write] = task;
    write += 1;
  }
  tasks.length = write;
  dirty = false;
}

/**
 * Whether a task's current wait is over.
 *
 * A task waiting on another is due the moment that one is `done` — which is true of a task that
 * was **cancelled** as well as one that finished. That is deliberate: the waiter resumes either
 * way, because the alternative is a task suspended forever on work that will never complete, and
 * a scope leaving would then have to hunt down waiters as well as owners.
 */
function isDue(frame: TaskFrame): boolean {
  if (frame.awaiting !== null) return frame.awaiting.done;
  return readClock(frame.clock) >= frame.deadline;
}

/** Whether a value a module exports is a task body, checked by shape rather than by declaration. */
function isTaskBody(value: unknown): value is TaskBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TaskBody>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.start === 'function' &&
    typeof candidate.resume === 'function'
  );
}

/**
 * What a patch will do to one live task, worked out before anything is written.
 *
 * Kept as data rather than applied on the spot for the reason `patchModule` gives about records: a
 * refusal on the third task must leave the first two exactly as they were, on the version their
 * frames belong to. A half-patched module is a state no source file describes.
 */
interface TaskRebind {
  readonly task: Task;
  readonly body: TaskBody;
  /** The block index the old `step` means in the new code. */
  readonly step: number;
  /** Frame properties the new version has and the old frame does not. */
  readonly add: readonly string[];
  /** Frame properties the old frame has and the new version does not. */
  readonly drop: readonly string[];
}

export type TaskRebindPlan =
  | { readonly ok: true; readonly rebinds: readonly TaskRebind[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether a scope's live tasks can be moved onto freshly compiled code, and how.
 *
 * ---
 *
 * ## A suspended task is state, and it was the one kind not being checked
 *
 * The record path has had the right shape for a while: compare the schemas, compute every migration
 * before mutating, refuse by name when a change cannot be carried. A live task frame is state in
 * exactly the same sense — it holds the task's locals and an integer selecting where it resumes —
 * and it was being handed to new code on the strength of the **exported name** alone.
 *
 * Two things went wrong quietly. A version that inserted an `await` earlier in the body renumbered
 * the resume points, so an old frame's `step` selected a continuation belonging to different source
 * — the task carried on running, at the wrong place, for ever. A version that added a local read a
 * frame field that was never initialised, so the arithmetic that used it produced `undefined` and
 * the failure surfaced somewhere else entirely.
 *
 * ## What identity a continuation has
 *
 * Not its integer. `conts` maps each block index to a **path** — the control-flow constructs around
 * the suspension and its ordinal among the suspensions at its level — so the question "is this the
 * same resume point" is asked of something an edit can be judged against. The sequence describes the
 * *shape* of a task's suspensions and deliberately says nothing about their content, which is what
 * lets a duration change and lets the code around an `await` be rewritten: hot reload is for exactly
 * those edits, and this file's own opening paragraph promises them.
 *
 * The whole sequence is compared rather than one id looked up, and the reason is at the comparison.
 *
 * ## What is migrated and what is refused
 *
 * A field the new version added is initialised to `undefined`, which is exactly what `start` does
 * for a local of a freshly spawned task. A field it dropped is deleted, so code still reading it
 * fails rather than seeing a value from a version that no longer exists. **A field whose type
 * changed is refused**, because there is nothing to convert it to — the same answer the record path
 * gives, and for the same reason: a `phase` that was an `f32` and is now a `String` has no value
 * that is both.
 */
export function planTaskRebind(
  owner: Scope,
  exports: Record<string, unknown>,
  /** The new version's `__drift.tasks`, and the old version's, keyed by task name. */
  next: Readonly<Record<string, TaskAbi>> | undefined,
  previous: Readonly<Record<string, TaskAbi>> | undefined,
): TaskRebindPlan {
  const rebinds: TaskRebind[] = [];

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (task === undefined || !task.live || task.owner !== owner) continue;

    const name = task.body.name;
    const replacement = exports[name];
    /*
     * A task whose name is gone from the new version is **left on its old code** rather than
     * cancelled: it is already running, its frame is still coherent, and killing live work because
     * a name moved would make renaming a task a scene reset.
     */
    if (!isTaskBody(replacement)) continue;

    const before = previous?.[name];
    const after = next?.[name];
    if (before === undefined || after === undefined) {
      return {
        ok: false,
        reason:
          `\`${name}\` is running and one of the two versions carries no task ABI, so there is ` +
          'nothing to check its frame and its resume point against. Recompile both with a version ' +
          'of the compiler that emits one.',
      };
    }

    const at = before.conts[task.frame.step];
    if (at === undefined || at === null) {
      return {
        ok: false,
        reason:
          `\`${name}\` is suspended at a point its own version does not name, so where it would ` +
          'resume in the new code cannot be worked out. The module was left on its previous version.',
      };
    }

    /*
     * **The whole shape has to match, not just this one id.**
     *
     * An id is a path and an ordinal among the suspensions at its level, which describes the shape
     * of a task's suspensions and deliberately says nothing about their content — so that changing
     * a duration or the code around an `await`, which is what hot reload is *for*, keeps it.
     *
     * The cost is that an id cannot be looked up on its own. Inserting an `await` at the start and
     * appending one at the end produce the same set of ids, and in the first case every id now
     * names a different suspension: a frame resuming at `0` would run the new first `await`'s
     * continuation believing it was its own. Comparing the sequences refuses both, which is the
     * honest reading of what these ids know.
     *
     * So: **edit a task's body freely while it is running; change where it suspends and the patch
     * is refused.** `indexOf` below then carries the frame onto whatever block index the new
     * version put that same resume point at, which control flow around it can still move.
     */
    if (!sameShape(before.conts, after.conts)) {
      return {
        ok: false,
        reason:
          `\`${name}\` is running, and the new version suspends in a different shape — an ` +
          '`await` was added, removed or moved. The frame is suspended at a resume point that no ' +
          'longer means the same place, so it cannot be carried across. Let the task finish, or ' +
          'restart the scene.',
      };
    }

    const step = after.conts.indexOf(at);

    const was = new Map(before.fields);
    const now = new Map(after.fields);
    for (const [field, type] of now) {
      const had = was.get(field);
      if (had !== undefined && had !== type) {
        return {
          ok: false,
          reason:
            `\`${name}\` is running and its \`${field}\` changed from \`${had}\` to ` +
            `\`${type}\`. There is no value that is both, so the live frame cannot be carried ` +
            'across. The module was left on its previous version.',
        };
      }
    }

    rebinds.push({
      task,
      body: replacement,
      step,
      add: [...now.keys()].filter((field) => !was.has(field)),
      drop: [...was.keys()].filter((field) => !now.has(field)),
    });
  }

  return { ok: true, rebinds };
}

/**
 * Carry out a plan `planTaskRebind` already proved.
 *
 * Nothing here can fail, which is the point: every question was answered before the first write.
 */
/** Whether two versions suspend in the same places, in the same order. */
function sameShape(
  before: readonly (string | null)[],
  after: readonly (string | null)[],
): boolean {
  const ids = (conts: readonly (string | null)[]): string =>
    conts.filter((id): id is string => id !== null).join('|');
  return ids(before) === ids(after);
}

export function applyTaskRebind(rebinds: readonly TaskRebind[]): void {
  for (const rebind of rebinds) {
    const frame = rebind.task.frame as unknown as Record<string, unknown>;
    for (const field of rebind.drop) delete frame[field];
    /* `undefined` rather than a zero, because it is what `start` writes for a local of a freshly
       spawned task — a patched frame and a new one differ in the values the task has computed, and
       in nothing else. */
    for (const field of rebind.add) frame[field] = undefined;
    rebind.task.frame.step = rebind.step;
    rebind.task.body = rebind.body;
  }
}

/**
 * How many tasks are alive.
 *
 * For a host that wants to see a leak rather than infer one: a scope entered per scene and never
 * left shows up here as a number that only goes up, which is the one failure mode ownership can
 * still be wired around. Counted rather than read off `tasks.length`, so the answer is the same
 * whether or not a compaction has run since the last death.
 */
export function liveTaskCount(): number {
  let alive = 0;
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (task !== undefined && task.live) alive += 1;
  }
  return alive;
}

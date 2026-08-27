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
 * Point a scope's live tasks at freshly compiled code, keeping every frame where it is.
 *
 * **This is what makes a task survive a hot reload rather than restart**, and it is the same
 * indirection `module.ts` describes one level up: the frame is the scheduler's, the code is the
 * module's, and a patch replaces only the second. A task mid-way through a three-second wait keeps
 * the two-and-a-half seconds it has already waited.
 *
 * Matched by name, because that is the only identity a task body has across a recompile — a fresh
 * compile produces new objects for everything. A task whose name is gone from the new version is
 * **left on its old code** rather than cancelled: it is already running, its frame is still
 * coherent, and killing live work because a name moved would make renaming a task a scene reset.
 * What would make that wrong is a rename that changes what the task *does* while it is suspended,
 * which is the shape-change problem `hot.ts` refuses for records and Phase 5 turns into migration.
 */
export function rebindTasks(owner: Scope, exports: Record<string, unknown>): void {
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (task === undefined || !task.live || task.owner !== owner) continue;
    const replacement = exports[task.body.name];
    if (isTaskBody(replacement)) task.body = replacement;
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

/**
 * Typed events: `emit Alarm { … }` on one side, `on Alarm as alarm { … }` on the other.
 *
 * **Dispatch is immediate**, which is the design's own reading: most events are, and the ones that
 * reach a presentation layer are *routed* to the engine's `MessageQueue` by a consumer rather than
 * passing through it on the way. That distinction is worth stating because it was nearly built the
 * other way round — a queue whose dedupe window collapses a repeat of the same id inside 900ms and
 * whose `current` is one message at a time is exactly right for notifications and would silently
 * drop a script's second `Alarm` in a second.
 *
 * The cost of immediate dispatch is that a handler runs inside the emitter's stack frame, so a
 * handler that emits re-enters this file. That is handled below rather than forbidden, because
 * forbidding it would make a chain of two events an error a script author cannot see coming.
 *
 * **What would make this wrong** is an event that must not be observed until a tick boundary — a
 * decision crossing into the simulation, which §33 already routes as a queued command rather than
 * as an event, for the same reason.
 *
 * ---
 *
 * ## No capability, and no target
 *
 * A dispatcher is control flow, not a host service: it observes nothing, reaches nothing, and has
 * no implementation a host could differ on. So `emit` and `on` work in every target, including one
 * that provides no `drift/*` at all — where the alternative would be a language whose `on` is
 * refused at link time for want of a provider nobody can write differently.
 *
 * A host that wants to *see* a script's events calls `on` itself with the module's scope, which is
 * the same door the generated code uses.
 */
import { type Scope, observeScopeLeave } from './scope.ts';

export interface Subscription {
  close(): void;
}

interface Handler {
  readonly fn: (payload: unknown) => void;
  readonly owner: Scope;
  /**
   * Whether an `on` declaration in a module registered this, rather than a host.
   *
   * A hot reload closes a module's own handlers and re-registers them from the new code. A host's
   * listener on the same scope must survive that: it was not re-registered by anything, and closing
   * it leaves a page that looks alive and hears nothing.
   */
  readonly generated: boolean;
  live: boolean;
}

const handlers = new Map<string, Handler[]>();

/** Names whose list holds a dead entry. Compacted at the next emit rather than during a leave. */
const stale = new Set<string>();

observeScopeLeave((scope) => {
  for (const [name, list] of handlers) {
    for (let i = 0; i < list.length; i += 1) {
      const handler = list[i];
      if (handler !== undefined && handler.live && handler.owner === scope) {
        handler.live = false;
        stale.add(name);
      }
    }
  }
});

/**
 * Listen for an event, for as long as `owner` is open.
 *
 * **The owner is not optional**, and that is the whole advantage the language has over a
 * subscription a script would otherwise have to remember to cancel: a module's handlers belong to
 * the module's scope, and disposing it closes them without the module knowing they existed.
 */
export function on(name: string, fn: (payload: unknown) => void, owner: Scope): Subscription {
  return listen(name, fn, owner, false);
}

/**
 * The same, for an `on` declaration inside a module.
 *
 * Separate from `on` rather than a flag on it, because the two differ in *lifetime* rather than in
 * degree: this one is re-registered by every reload, and a caller passing `true` by mistake would
 * find their listener silently closed by the next edit.
 */
export function onGenerated(
  name: string,
  fn: (payload: unknown) => void,
  owner: Scope,
): Subscription {
  return listen(name, fn, owner, true);
}

function listen(
  name: string,
  fn: (payload: unknown) => void,
  owner: Scope,
  generated: boolean,
): Subscription {
  const handler: Handler = { fn, owner, generated, live: true };
  const list = handlers.get(name);
  if (list === undefined) handlers.set(name, [handler]);
  else list.push(handler);

  return {
    close(): void {
      if (!handler.live) return;
      handler.live = false;
      stale.add(name);
    },
  };
}

/**
 * Deliver an event to everything listening, in the order the listeners registered.
 *
 * The list length is read once, so a handler that registers another listener for the same event
 * does not have it run for the event already being delivered — which would be a handler observing
 * something that happened before it existed, and a chain that can loop.
 */
export function emit(name: string, payload: unknown): void {
  if (stale.has(name)) {
    compact(name);
    stale.delete(name);
  }

  const list = handlers.get(name);
  if (list === undefined) return;
  const count = list.length;
  for (let i = 0; i < count; i += 1) {
    const handler = list[i];
    /* Checked at the moment of the call rather than before the loop: a handler that closes a later
       one, or leaves the scope owning it, must not then have it run. */
    if (handler !== undefined && handler.live) handler.fn(payload);
  }
}

function compact(name: string): void {
  const list = handlers.get(name);
  if (list === undefined) return;
  let write = 0;
  for (let read = 0; read < list.length; read += 1) {
    const handler = list[read];
    if (handler === undefined || !handler.live) continue;
    list[write] = handler;
    write += 1;
  }
  list.length = write;
  if (write === 0) handlers.delete(name);
}

/**
 * Close the handlers a *module* registered on a scope, leaving a host's alone.
 *
 * For a hot reload, which replaces a module's code while its tasks keep their frames. A handler has
 * no frame — it is a function and nothing else — so re-registering from the new version is both
 * correct and simpler than pointing a live one at new code.
 *
 * **A host's listener on the same scope must survive**, and this is what that costs. Closing
 * everything was the first version, and it was found by editing a `.drs` file in a running page:
 * the reload reported "patched, state preserved", the task went on emitting, and the counter on
 * the page stopped moving — because the only thing listening had been the page, and the patch had
 * closed it. Nothing failed anywhere; the page just went quiet.
 */
export function closeGeneratedHandlersOf(owner: Scope): void {
  for (const [name, list] of handlers) {
    for (let i = 0; i < list.length; i += 1) {
      const handler = list[i];
      if (handler !== undefined && handler.live && handler.generated && handler.owner === owner) {
        handler.live = false;
        stale.add(name);
      }
    }
  }
}

/** How many handlers are listening for a name. For a host looking at a leak rather than inferring one. */
export function listenerCount(name: string): number {
  const list = handlers.get(name);
  if (list === undefined) return 0;
  let alive = 0;
  for (let i = 0; i < list.length; i += 1) if (list[i]?.live === true) alive += 1;
  return alive;
}

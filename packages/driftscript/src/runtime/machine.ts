/**
 * Generic state machines: `state Closed { on Open { become Opening } }`.
 *
 * **These are the language's and have nothing to do with animation.** A host's
 * `AnimationStateMachine` blends poses; this blends nothing and knows nothing about a skeleton. A
 * reader who conflates them will go looking for a pose and find a string. The design's own list is
 * camera modes, interface flow, interactive objects, mission structure, tool workflows — and
 * A state machine over ids belongs to the language rather than to any host that uses one.
 *
 * ---
 *
 * ## A state owns what it starts
 *
 * Each state runs in a scope of its own, under the machine's. Leaving the state leaves that scope,
 * which cancels its entry task and anything the entry task spawned — so a state that was half-way
 * through a two-second open animation when something told it to close does not go on animating.
 *
 * That is the whole reason an entry block is a **task** rather than a function: it can suspend, and
 * a thing that can suspend needs an owner or it outlives what started it.
 *
 * ## Transitions are depth-first, and re-entrancy is refused rather than queued
 *
 * `become` inside an entry block transitions immediately, so entering A can enter B before A's
 * entry has finished. What is refused is a `become` that arrives *while a transition is already in
 * progress*: that is a machine changing state underneath its own bookkeeping, and the honest
 * failure is a refusal naming both states rather than a `current` that depends on call order.
 *
 * **What would make this wrong** is a machine that legitimately needs to queue transitions — a
 * request arriving mid-transition that should be honoured next rather than dropped. That is a
 * different machine with a different contract, and it should say so in its own type rather than be
 * a mode of this one.
 */
import { type Scope, createScope } from './scope.ts';
import { type TaskBody, spawn } from './tasks.ts';

export interface Machine {
  readonly current: string;
  /** Deliver an event to whatever the current state does with it. Unhandled events are ignored. */
  send(event: string, payload?: unknown): void;
  /** Go to a state directly. What `become` compiles to, and what a host uses to force one. */
  become(state: string): void;
  /** Stop the machine, leaving the current state and cancelling what it started. */
  stop(): void;
}

export interface StateDefinition {
  /** The state's `enter` block, compiled as a task so it can suspend. */
  readonly enter: TaskBody | null;
  /** The `on Event { … }` blocks, by event name. */
  readonly on: Readonly<Record<string, (machine: Machine, payload: unknown) => void>>;
}

export function createMachine(
  initial: string,
  states: Readonly<Record<string, StateDefinition>>,
  owner: Scope,
): Machine {
  let current = '';
  let scope: Scope | null = null;
  let transitioning = false;
  let stopped = false;

  const leave = (): void => {
    if (scope !== null) scope.leave();
    scope = null;
  };

  const machine: Machine = {
    get current(): string {
      return current;
    },

    send(event: string, payload?: unknown): void {
      if (stopped) return;
      const handler = states[current]?.on[event];
      if (handler === undefined) return;
      handler(machine, payload);
    },

    become(state: string): void {
      if (stopped) return;
      const definition = states[state];
      if (definition === undefined) {
        /*
         * The compiler refuses a `become` naming a state nothing declares, so reaching this means a
         * host called `become` with a name of its own. Refusing in words beats a machine whose
         * `current` is a state that does not exist and whose every `send` then finds nothing.
         */
        throw new Error(
          `\`${state}\` is not a state of this machine. It has: ${Object.keys(states).join(', ')}.`,
        );
      }
      /*
       * Only a host's own scope-leave callback can reach this, because nothing in `leave` calls
       * back into the machine — so no test exercises it, deliberately, rather than one being
       * written that cannot fail. It stays because the alternative is a `current` that depends on
       * the order two calls happened to arrive in, and four lines is a cheap price for that not
       * being possible.
       */
      if (transitioning) {
        throw new Error(
          `\`${current}\` is already transitioning, so it cannot also become \`${state}\`. A ` +
            'machine that changed state underneath its own bookkeeping would leave `current` ' +
            'depending on the order the calls happened to arrive in.',
        );
      }

      transitioning = true;
      try {
        leave();
        current = state;
        scope = createScope(owner);
      } finally {
        transitioning = false;
      }

      /*
       * The entry task starts *after* the transition is marked complete, so a `become` inside an
       * entry block is an ordinary transition rather than a re-entrant one. Entering A may enter B
       * before A's entry has run to its first suspend, and that is the behaviour the design's
       * `Opening` state is built on.
       */
      if (definition.enter !== null && scope !== null) spawn(definition.enter, scope, machine);
    },

    stop(): void {
      stopped = true;
      leave();
      current = '';
    },
  };

  machine.become(initial);
  return machine;
}

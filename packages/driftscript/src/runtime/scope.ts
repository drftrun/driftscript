/**
 * A scope: the thing that owns work, and cancels it when it ends.
 *
 * **This is the discipline a host otherwise runs by hand** — cancel the frame, unbind the controls,
 * dispose the handle — and the whole point of putting it in the language is that a script cannot
 * forget it. Leaving a scope ends everything started inside it, including the scopes it opened.
 *
 * ---
 *
 * ## It knows nothing about what it owns
 *
 * A scope does not know that tasks exist, or that event handlers do. Each subsystem registers an
 * observer once and does its own cleanup when a scope is left, which is what lets a second kind of
 * owned thing land without this file changing — and it did: tasks were the only kind when this was
 * written, and handlers arrived a commit later.
 *
 * The cost is that a leave is a walk over every observer rather than over a list of what this scope
 * actually owns, and there is no one place to read to find out what a scope holds. That is bounded
 * by the number of *kinds* of owned thing, which is two, rather than by how many are owned.
 *
 * **What would make it wrong** is an owned thing whose cleanup has to happen in a defined order
 * relative to another kind's. Nothing does today — a cancelled task and a closed handler do not
 * observe each other — and the fix if one appears is an ordered list here, not an observer that
 * reaches into another subsystem.
 */

export interface Scope {
  enter(): void;
  leave(): void;
}

/** Scopes that have been left, so a spawn into one can be refused rather than detached. */
const left = new WeakSet<Scope>();

/**
 * The scopes each scope opened, so leaving one leaves what it contains.
 *
 * A `Set` per scope rather than a parent pointer per child, because leaving is the direction that
 * has to be complete: a parent must be able to name its children, and a child that has already left
 * removes itself so a long-lived parent does not accumulate them.
 */
const children = new WeakMap<Scope, Set<Scope>>();

const observers: ((scope: Scope) => void)[] = [];

/** Be told when any scope is left. Registered once per subsystem, at module load. */
export function observeScopeLeave(observer: (scope: Scope) => void): void {
  observers.push(observer);
}

/** Whether a scope has been left and not re-entered. */
export function hasLeft(scope: Scope): boolean {
  return left.has(scope);
}

function childrenOf(scope: Scope): Set<Scope> {
  const existing = children.get(scope);
  if (existing !== undefined) return existing;
  const made = new Set<Scope>();
  children.set(scope, made);
  return made;
}

/**
 * A scope, optionally inside another.
 *
 * Re-entering is what a host does when it reuses a scope for a new scene. It is not a counter: a
 * scope is either open or left, because a depth count would let a mismatched pair leave a scope
 * that a caller believes is still holding its work.
 */
export function createScope(parent?: Scope): Scope {
  const scope: Scope = {
    enter(): void {
      left.delete(scope);
      if (parent !== undefined) childrenOf(parent).add(scope);
    },
    leave(): void {
      left.add(scope);
      if (parent !== undefined) children.get(parent)?.delete(scope);

      /* Children first. What a child owns is not this scope's, so an observer looking for things
         owned by *this* scope would walk straight past them. */
      const mine = children.get(scope);
      if (mine !== undefined) {
        for (const child of [...mine]) child.leave();
        mine.clear();
      }

      for (let i = 0; i < observers.length; i += 1) observers[i]?.(scope);
    },
  };
  if (parent !== undefined) childrenOf(parent).add(scope);
  return scope;
}

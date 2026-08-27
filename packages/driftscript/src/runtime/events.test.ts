import { describe, expect, it } from 'vitest';
import { createScope } from './scope.ts';
import { closeGeneratedHandlersOf, emit, listenerCount, on, onGenerated } from './events.ts';

describe('typed events', () => {
  it('delivers a payload to everything listening, in registration order', () => {
    const scope = createScope();
    const seen: string[] = [];
    on('Alarm', (p) => seen.push(`a:${(p as { at: number }).at}`), scope);
    on('Alarm', (p) => seen.push(`b:${(p as { at: number }).at}`), scope);

    emit('Alarm', { at: 3 });

    expect(seen).toEqual(['a:3', 'b:3']);
    scope.leave();
  });

  it('delivers nothing for a name nobody is listening for', () => {
    expect(() => emit('Nobody', {})).not.toThrow();
  });

  it('delivers a repeat, rather than collapsing it as a duplicate', () => {
    /*
     * The failure a notification queue would have introduced. `MessageQueue` ignores a repeat of an
     * id inside its dedupe window, which is right for a toast and wrong for an event: two alarms in
     * a second are two things that happened.
     */
    const scope = createScope();
    let count = 0;
    on('Alarm', () => (count += 1), scope);

    emit('Alarm', {});
    emit('Alarm', {});
    emit('Alarm', {});

    expect(count).toBe(3);
    scope.leave();
  });

  it('closes a handler when the scope that owns it is left', () => {
    const scope = createScope();
    let count = 0;
    on('Alarm', () => (count += 1), scope);

    scope.leave();
    emit('Alarm', {});

    expect(count).toBe(0);
    expect(listenerCount('Alarm')).toBe(0);
  });

  it('leaves a handler in another scope listening, so closing is ownership rather than a flush', () => {
    const doomed = createScope();
    const kept = createScope();
    let alive = 0;
    on('Alarm', () => undefined, doomed);
    on('Alarm', () => (alive += 1), kept);

    doomed.leave();
    emit('Alarm', {});

    expect(alive).toBe(1);
    kept.leave();
  });

  it('closes a handler an inner scope owns when the outer one is left', () => {
    const outer = createScope();
    const inner = createScope(outer);
    let count = 0;
    on('Alarm', () => (count += 1), inner);

    outer.leave();
    emit('Alarm', {});

    expect(count).toBe(0);
  });

  it('stops delivering to a subscription that closed itself', () => {
    const scope = createScope();
    let count = 0;
    const subscription = on('Alarm', () => (count += 1), scope);

    emit('Alarm', {});
    subscription.close();
    emit('Alarm', {});

    expect(count).toBe(1);
    scope.leave();
  });

  it('does not deliver to a handler registered while the same event is being delivered', () => {
    /* It would be a handler observing something that happened before it existed — and, for a
       handler that registers on every delivery, a loop that never returns. */
    const scope = createScope();
    let late = 0;
    on('Alarm', () => {
      on('Alarm', () => (late += 1), scope);
    }, scope);

    emit('Alarm', {});

    expect(late).toBe(0);
    scope.leave();
  });

  it('does not deliver to a handler another handler closed mid-delivery', () => {
    const scope = createScope();
    let second = 0;
    const later = { close: () => undefined } as { close: () => void };
    on('Alarm', () => later.close(), scope);
    const subscription = on('Alarm', () => (second += 1), scope);
    later.close = () => subscription.close();

    emit('Alarm', {});

    expect(second).toBe(0);
    scope.leave();
  });

  it('closes a module handler for a reload without leaving the scope', () => {
    /* A hot patch replaces a module's code. A handler has no frame to keep, so it is closed and
       registered again from the new version rather than pointed at it. */
    const scope = createScope();
    let count = 0;
    onGenerated('Alarm', () => (count += 1), scope);

    closeGeneratedHandlersOf(scope);
    emit('Alarm', {});
    expect(count).toBe(0);

    onGenerated('Alarm', () => (count += 1), scope);
    emit('Alarm', {});
    expect(count).toBe(1);

    scope.leave();
  });

  it('leaves a host listener on the same scope alone across a reload', () => {
    /*
     * Found by editing a `.drs` file in a running page. The reload reported "patched, state
     * preserved", the task went on emitting, and the counter on the page stopped moving — because
     * the only thing listening had been the page, and closing every handler on the scope had
     * closed it. Nothing failed anywhere; the page just went quiet.
     */
    const scope = createScope();
    let host = 0;
    let module = 0;
    on('Alarm', () => (host += 1), scope);
    onGenerated('Alarm', () => (module += 1), scope);

    closeGeneratedHandlersOf(scope);
    emit('Alarm', {});

    expect(host).toBe(1);
    expect(module).toBe(0);
    scope.leave();
  });

  it('still closes a host listener when the scope itself is left', () => {
    /* The control: surviving a *reload* is not surviving a teardown. A host's listener belongs to
       the scope it named, and disposing the module ends it like anything else. */
    const scope = createScope();
    let host = 0;
    on('Alarm', () => (host += 1), scope);

    scope.leave();
    emit('Alarm', {});

    expect(host).toBe(0);
  });
});

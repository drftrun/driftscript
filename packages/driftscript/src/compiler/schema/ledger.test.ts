import { describe, expect, it } from 'vitest';
import { createInterfaceLedger } from './ledger.ts';

describe('the interface ledger', () => {
  it('calls the first sight of a module a move, because nothing downstream was built against it', () => {
    const ledger = createInterfaceLedger();
    expect(ledger.record('a.drs', 'aaaaaaaa')).toEqual({ moved: true, interfaceHash: 'aaaaaaaa' });
  });

  it('calls an identical interface unmoved', () => {
    const ledger = createInterfaceLedger();
    ledger.record('a.drs', 'aaaaaaaa');
    expect(ledger.record('a.drs', 'aaaaaaaa')).toEqual({ moved: false, interfaceHash: 'aaaaaaaa' });
  });

  it('calls a different interface moved', () => {
    const ledger = createInterfaceLedger();
    ledger.record('a.drs', 'aaaaaaaa');
    expect(ledger.record('a.drs', 'bbbbbbbb')).toEqual({ moved: true, interfaceHash: 'bbbbbbbb' });
  });

  /**
   * The retention, from both sides.
   *
   * A file that does not compile has no interface, and the two obvious readings of that are both
   * wrong. Reading it as "the interface changed" recompiles every dependent on every keystroke that
   * leaves a file half-typed, which is most of them. Reading it as "forget what we knew" is worse
   * and is the one that produces a wrong answer rather than a slow one: the next compile that
   * succeeds then has nothing to compare against.
   */
  it('does not move on a compile that failed', () => {
    const ledger = createInterfaceLedger();
    ledger.record('a.drs', 'aaaaaaaa');
    expect(ledger.record('a.drs', undefined)).toEqual({ moved: false, interfaceHash: 'aaaaaaaa' });
  });

  /*
   * This is the assertion that separates the correct implementation from both wrong ones, and it is
   * the only one here that does. Asserting instead that an interface edited *during* the failure
   * comes back moved passes under all three — deleting the entry and recording the empty hash both
   * make an unknown module look changed — so it was written, watched pass under a perturbation, and
   * removed. A test that cannot fail is not evidence.
   */
  it('reports the same interface as unmoved across a failure that came between', () => {
    const ledger = createInterfaceLedger();
    ledger.record('a.drs', 'aaaaaaaa');
    ledger.record('a.drs', undefined);
    expect(ledger.record('a.drs', 'aaaaaaaa').moved).toBe(false);
  });

  it('has no interface for a module whose first compile failed', () => {
    const ledger = createInterfaceLedger();
    expect(ledger.record('a.drs', undefined)).toEqual({ moved: false, interfaceHash: '' });
    expect(ledger.lastGood('a.drs')).toBeUndefined();
  });

  it('treats an empty hash as no interface, because that is what a failed compile carries', () => {
    /* `CompileResult.metadata.interfaceHash` is `''` on failure rather than absent, so a caller
       forwarding it straight through must not be read as having reported an interface of `''`. */
    const ledger = createInterfaceLedger();
    ledger.record('a.drs', 'aaaaaaaa');
    expect(ledger.record('a.drs', '')).toEqual({ moved: false, interfaceHash: 'aaaaaaaa' });
  });

  it('forgets a module, so a deleted file does not answer for one created later at its path', () => {
    const ledger = createInterfaceLedger();
    ledger.record('a.drs', 'aaaaaaaa');
    ledger.forget('a.drs');
    expect(ledger.lastGood('a.drs')).toBeUndefined();
    expect(ledger.record('a.drs', 'aaaaaaaa').moved).toBe(true);
  });

  it('keys the interface on the module, so two modules never answer for each other', () => {
    const ledger = createInterfaceLedger();
    ledger.record('a.drs', 'aaaaaaaa');
    expect(ledger.record('b.drs', 'aaaaaaaa').moved).toBe(true);
  });
});

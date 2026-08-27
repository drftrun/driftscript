import { describe, expect, it } from 'vitest';
import { type ScheduleWorkspace, createScheduler } from './schedule.ts';
import { createService } from './service.ts';

/**
 * A workspace over two literal maps: what each module's interface currently hashes to, and who
 * imports whom.
 *
 * The hashes are written by hand rather than compiled, because what is under test here is the
 * decision the scheduler takes given a hash that moved or did not. Compiling real sources would
 * test `interfaceHash` a second time and would make the interesting cases — a file that does not
 * compile, an interface edited while it did not — awkward to reach.
 */
function workspace(
  interfaces: Record<string, string | undefined>,
  dependents: Record<string, readonly string[]> = {},
): ScheduleWorkspace {
  return {
    interfaceOf: (module) => interfaces[module],
    dependentsOf: (module) => dependents[module] ?? [],
  };
}

describe('the incremental scheduler', () => {
  it('recompiles the edited file alone when only a body changed', () => {
    const interfaces: Record<string, string | undefined> = { 'a.drs': 'aaaaaaaa' };
    const scheduler = createScheduler(workspace(interfaces, { 'a.drs': ['b.drs'] }));

    /* The first sight of a module is a move — nothing downstream was built against it — so the
       ledger is seeded before the edit under test. This is what an editor does on open. */
    scheduler.schedule('a.drs');

    /* A body edit. `interfaceHash` is documented to be identical across one, so the map does not
       move, and nothing that depends on `a.drs` can be affected by it. */
    expect(scheduler.schedule('a.drs')).toEqual({ recompile: ['a.drs'] });
  });

  it('recompiles the dependents when an interface changed', () => {
    const interfaces: Record<string, string | undefined> = { 'a.drs': 'aaaaaaaa' };
    const scheduler = createScheduler(workspace(interfaces, { 'a.drs': ['b.drs', 'c.drs'] }));
    scheduler.schedule('a.drs');

    interfaces['a.drs'] = 'bbbbbbbb';
    expect(scheduler.schedule('a.drs').recompile).toEqual(['a.drs', 'b.drs', 'c.drs']);
  });

  /**
   * The third of the three the plan names, and the one with a wrong implementation waiting for it.
   *
   * A file mid-edit does not parse on most keystrokes, so it has no interface at all. Reading that
   * as a move rebuilds every dependent on nearly every keystroke. Recording it — overwriting what
   * was known with nothing — is worse, because the next compile that succeeds then has nothing to
   * compare against, and an interface edited *while* the file was broken is either missed or forces
   * a full rebuild depending on how an unknown module happens to be treated.
   *
   * So the decision is taken against the last good interface, in both directions: nothing downstream
   * moves while the file is broken, and the comparison when it comes back is against the hash the
   * failure did not overwrite.
   */
  it('schedules dependents on the last good interface when a file has a syntax error', () => {
    const interfaces: Record<string, string | undefined> = { 'a.drs': 'aaaaaaaa' };
    const scheduler = createScheduler(workspace(interfaces, { 'a.drs': ['b.drs'] }));
    scheduler.schedule('a.drs');

    /* Half-typed: the compile fails, so there is no interface to report. */
    interfaces['a.drs'] = undefined;
    expect(scheduler.schedule('a.drs')).toEqual({ recompile: ['a.drs'] });

    /* Finished typing, and the interface is what it always was. The failure in between must not
       have made this look like a change. */
    interfaces['a.drs'] = 'aaaaaaaa';
    expect(scheduler.schedule('a.drs')).toEqual({ recompile: ['a.drs'] });
  });

  it('sees an interface that changed while the file did not compile', () => {
    const interfaces: Record<string, string | undefined> = { 'a.drs': 'aaaaaaaa' };
    const scheduler = createScheduler(workspace(interfaces, { 'a.drs': ['b.drs'] }));
    scheduler.schedule('a.drs');

    interfaces['a.drs'] = undefined;
    scheduler.schedule('a.drs');

    /* The author added a field while the file was unparseable. The move is only visible against the
       hash the failed compile did not overwrite. */
    interfaces['a.drs'] = 'bbbbbbbb';
    expect(scheduler.schedule('a.drs').recompile).toEqual(['a.drs', 'b.drs']);
  });

  it('recompiles a dependent of a dependent only when the one between it also moved', () => {
    /*
     * a ← b ← c. `a`'s interface moves, so `b` recompiles. `b`'s own interface is unchanged, so
     * nothing `b` publishes is different and `c` has no reason to rebuild. Stopping there is the
     * whole point of hashing an interface rather than a source.
     */
    const interfaces: Record<string, string | undefined> = {
      'a.drs': 'aaaaaaaa',
      'b.drs': 'bbbbbbbb',
      'c.drs': 'cccccccc',
    };
    const scheduler = createScheduler(
      workspace(interfaces, { 'a.drs': ['b.drs'], 'b.drs': ['c.drs'] }),
    );
    scheduler.schedule('a.drs');
    scheduler.schedule('b.drs');
    scheduler.schedule('c.drs');

    interfaces['a.drs'] = 'a2222222';
    expect(scheduler.schedule('a.drs').recompile).toEqual(['a.drs', 'b.drs']);
  });

  it('carries on through a dependent whose own interface moved in the same edit', () => {
    const interfaces: Record<string, string | undefined> = {
      'a.drs': 'aaaaaaaa',
      'b.drs': 'bbbbbbbb',
      'c.drs': 'cccccccc',
    };
    const scheduler = createScheduler(
      workspace(interfaces, { 'a.drs': ['b.drs'], 'b.drs': ['c.drs'] }),
    );
    scheduler.schedule('a.drs');
    scheduler.schedule('b.drs');
    scheduler.schedule('c.drs');

    interfaces['a.drs'] = 'a2222222';
    interfaces['b.drs'] = 'b2222222';
    expect(scheduler.schedule('a.drs').recompile).toEqual(['a.drs', 'b.drs', 'c.drs']);
  });

  it('visits a module once when two paths reach it', () => {
    const interfaces: Record<string, string | undefined> = {
      'a.drs': 'aaaaaaaa',
      'b.drs': 'bbbbbbbb',
      'c.drs': 'cccccccc',
      'd.drs': 'dddddddd',
    };
    const scheduler = createScheduler(
      workspace(interfaces, { 'a.drs': ['b.drs', 'c.drs'], 'b.drs': ['d.drs'], 'c.drs': ['d.drs'] }),
    );
    for (const module of ['a.drs', 'b.drs', 'c.drs', 'd.drs']) scheduler.schedule(module);

    interfaces['a.drs'] = 'a2222222';
    interfaces['b.drs'] = 'b2222222';
    interfaces['c.drs'] = 'c2222222';
    expect(scheduler.schedule('a.drs').recompile).toEqual(['a.drs', 'b.drs', 'c.drs', 'd.drs']);
  });

  it('terminates on a dependency cycle', () => {
    /* Two modules that depend on each other. Without the visited set this walks forever, and a
       language server that hangs on a keystroke is worse than one that rebuilds too much. */
    const interfaces: Record<string, string | undefined> = { 'a.drs': 'aaaaaaaa', 'b.drs': 'bbbbbbbb' };
    const scheduler = createScheduler(
      workspace(interfaces, { 'a.drs': ['b.drs'], 'b.drs': ['a.drs'] }),
    );
    scheduler.schedule('a.drs');
    scheduler.schedule('b.drs');

    interfaces['a.drs'] = 'a2222222';
    interfaces['b.drs'] = 'b2222222';
    expect(scheduler.schedule('a.drs').recompile).toEqual(['a.drs', 'b.drs']);
  });

  it('forgets a module, so a closed document does not answer for a reopened one', () => {
    const interfaces: Record<string, string | undefined> = { 'a.drs': 'aaaaaaaa' };
    const scheduler = createScheduler(workspace(interfaces, { 'a.drs': ['b.drs'] }));
    scheduler.schedule('a.drs');
    scheduler.forget('a.drs');

    /* First sight again, so the safe direction is taken again. */
    expect(scheduler.schedule('a.drs').recompile).toEqual(['a.drs', 'b.drs']);
  });
});

/**
 * The wiring, against real compiler output.
 *
 * Every test above hands the scheduler a hash written by hand, which is right for testing the
 * decision and proves nothing about whether the service feeds it the real one. These two compile
 * actual source, so a service wired to the wrong field — or to a hash it computed itself — fails
 * here and nowhere else.
 */
describe('the service schedules on what it compiled', () => {
  const BODY = 'data P {\n    a: f32 = 0\n}\n\nfn update(p: mut P, dt: f32) {\n    p.a += %\n}\n';

  it('recompiles the edited file alone for a body edit', () => {
    const service = createService({ dependentsOf: () => ['main.ts'] });
    service.open('p.drs', BODY.replace('%', 'dt'));
    service.schedule('p.drs');

    service.change('p.drs', BODY.replace('%', 'dt * 2'));
    expect(service.schedule('p.drs')).toEqual({ recompile: ['p.drs'] });
  });

  it('recompiles the dependents when a record gains a field', () => {
    const service = createService({ dependentsOf: () => ['main.ts'] });
    service.open('p.drs', BODY.replace('%', 'dt'));
    service.schedule('p.drs');

    service.change('p.drs', BODY.replace('a: f32 = 0', 'a: f32 = 0\n    b: f32 = 1').replace('%', 'dt'));
    expect(service.schedule('p.drs').recompile).toEqual(['p.drs', 'main.ts']);
  });

  it('leaves the dependents alone while the file does not parse', () => {
    const service = createService({ dependentsOf: () => ['main.ts'] });
    service.open('p.drs', BODY.replace('%', 'dt'));
    service.schedule('p.drs');

    /* Half-typed, exactly as an editor sees it between two keystrokes. */
    service.change('p.drs', 'data P {\n');
    expect(service.schedule('p.drs')).toEqual({ recompile: ['p.drs'] });
  });
});

/**
 * Resolving through open documents, which is the whole reason the host is a parameter.
 *
 * An editor computing errors from the saved version of a file somebody is mid-way through changing
 * is an editor showing yesterday's errors. Until this landed the service passed `singleFileHost()`,
 * so every relative import in every open file reported `DS0501` — the refusal was correct and the
 * situation was not.
 */
describe('the service resolves modules through open documents', () => {
  const CREATURE = 'data Creature {\n    name: String = ""\n    energy: f32 = 1\n}\n';
  const WOLF = 'import { Creature } from "./traits"\n\ndata Wolf : Creature {\n    packSize: i32 = 0\n}\n';

  it('resolves a relative import against another open document', () => {
    const service = createService();
    service.open('file:///a/traits.drs', CREATURE);
    service.open('file:///a/wolf.drs', WOLF);
    expect(service.diagnostics('file:///a/wolf.drs')).toEqual([]);
  });

  it('sees an unsaved edit in the file being imported', () => {
    /* Nothing here is on disk. A host that read the filesystem would resolve nothing at all, and one
       that read the *saved* version would answer about a file that no longer exists as typed. */
    const service = createService();
    service.open('file:///a/traits.drs', CREATURE);
    service.open(
      'file:///a/wolf.drs',
      'import { Creature } from "./traits"\n\nfn go(c: Creature) -> String {\n    return c.name\n}\n',
    );
    expect(service.diagnostics('file:///a/wolf.drs')).toEqual([]);

    service.change('file:///a/traits.drs', 'data Creature {\n    nickname: String = ""\n}\n');
    /* `name` is gone, so the reader of it is now wrong — and only the open buffer says so. */
    expect(service.diagnostics('file:///a/wolf.drs').length).toBeGreaterThan(0);
  });

  it('falls back to what the host can read when a document is not open', () => {
    const service = createService({
      readFile: (path) => (path.endsWith('traits.drs') ? CREATURE : null),
    });
    service.open('file:///a/wolf.drs', WOLF);
    expect(service.diagnostics('file:///a/wolf.drs')).toEqual([]);
  });

  it('prefers the open buffer over what the host would read', () => {
    const service = createService({ readFile: () => CREATURE });
    service.open('file:///a/traits.drs', 'data Creature {\n    nickname: String = ""\n}\n');
    service.open(
      'file:///a/wolf.drs',
      'import { Creature } from "./traits"\n\nfn go(c: Creature) -> String {\n    return c.name\n}\n',
    );
    /* The saved copy still has `name`; the buffer does not. The buffer wins. */
    expect(service.diagnostics('file:///a/wolf.drs').length).toBeGreaterThan(0);
  });

  it('recompiles a dependent when the interface it imports moves', () => {
    const service = createService();
    service.open('file:///a/traits.drs', CREATURE);
    service.open('file:///a/wolf.drs', WOLF);
    service.schedule('file:///a/traits.drs');
    service.schedule('file:///a/wolf.drs');

    service.change('file:///a/traits.drs', 'data Creature {\n    name: String = ""\n    age: i32 = 0\n}\n');
    expect(service.schedule('file:///a/traits.drs').recompile).toContain('file:///a/wolf.drs');
  });

  it('leaves the dependent alone when only a body in the imported file moves', () => {
    const body = `${CREATURE}\nfn tick() -> i32 {\n    return %\n}\n`;
    const service = createService();
    service.open('file:///a/traits.drs', body.replace('%', '1'));
    service.open('file:///a/wolf.drs', WOLF);
    service.schedule('file:///a/traits.drs');
    service.schedule('file:///a/wolf.drs');

    service.change('file:///a/traits.drs', body.replace('%', '2'));
    expect(service.schedule('file:///a/traits.drs').recompile).toEqual(['file:///a/traits.drs']);
  });

  it('builds the dependency graph from what it compiled, not from a list somebody maintains', () => {
    /* The edges come from `metadata.imports`, so a file that starts importing another is a dependent
       from the next compile — no registration step to forget. */
    const service = createService();
    service.open('file:///a/traits.drs', CREATURE);
    service.open('file:///a/wolf.drs', 'data Lone {\n    a: f32 = 0\n}\n');
    service.schedule('file:///a/traits.drs');
    service.schedule('file:///a/wolf.drs');

    service.change('file:///a/wolf.drs', WOLF);
    service.schedule('file:///a/wolf.drs');
    service.change('file:///a/traits.drs', 'data Creature {\n    name: String = ""\n    age: i32 = 0\n}\n');
    expect(service.schedule('file:///a/traits.drs').recompile).toContain('file:///a/wolf.drs');
  });
});

import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';
import { parse } from '../parser.ts';
import { check } from '../check/checker.ts';
import { disposeModule, loadModule } from '../../runtime/module.ts';
import { patchModule } from '../../runtime/hot.ts';
import { emit, listenerCount, on } from '../../runtime/events.ts';

const compile = (source: string) => {
  const { code, diagnostics } = compileDriftScript(source, {
    filename: 't.drs',
    host: singleFileHost(),
    mode: 'development',
  });
  expect(diagnostics).toEqual([]);
  return code;
};

const load = async (source: string) =>
  loadModule(
    (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(compile(source))}`
    )) as Record<string, unknown>,
  );

const codes = (source: string): string[] => {
  const { module, diagnostics } = parse(source, 't.drs');
  expect(diagnostics).toEqual([]);
  return check(module, 't.drs').diagnostics.map((d) => d.code);
};

const ALARM =
  'event Alarm {\n' +
  '    strength: f32\n' +
  '    source: i32 = 7\n' +
  '}\n';

describe('an emitted event', () => {
  it('reaches a handler declared in the same module', async () => {
    const module = await load(`${ALARM}\nfn fire() {\n    emit Alarm { strength: 0.5 }\n}\n`);

    const seen: unknown[] = [];
    on('Alarm', (payload) => seen.push(payload), module.scope);
    (module.exports.fire as () => void)();

    expect(seen).toEqual([{ strength: 0.5, source: 7 }]);
    disposeModule(module);
  });

  it('fills a default and orders fields as declared, not as written', async () => {
    /*
     * Two emits of one event build the same shape, so an engine holds one hidden class per event
     * rather than one per call site. Written in the other order here on purpose.
     */
    const module = await load(
      `${ALARM}\nfn fire() {\n    emit Alarm { source: 2, strength: 0.5 }\n}\n`,
    );

    let payload: Record<string, unknown> = {};
    on('Alarm', (p) => (payload = p as Record<string, unknown>), module.scope);
    (module.exports.fire as () => void)();

    expect(Object.keys(payload)).toEqual(['strength', 'source']);
    expect(payload).toEqual({ strength: 0.5, source: 2 });
    disposeModule(module);
  });

  it('registers a module handler at load and closes it on disposal, unasked', async () => {
    /* The advantage over a subscription: the module never mentions teardown, and there is no way
       to dispose it and leave the handler listening. */
    const module = await load(`${ALARM}\non Alarm as alarm {\n}\n`);
    expect(listenerCount('Alarm')).toBe(1);

    disposeModule(module);
    expect(listenerCount('Alarm')).toBe(0);
  });

  it('re-registers a handler across a hot reload rather than doubling it', async () => {
    const module = await load(`${ALARM}\non Alarm as alarm {\n}\n`);
    expect(listenerCount('Alarm')).toBe(1);

    const next = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(compile(`${ALARM}\non Alarm as alarm {\n}\n\nfn other() {\n}\n`))}`
    )) as Record<string, unknown>;
    expect(patchModule(module, next)).toEqual({ patched: true });

    expect(listenerCount('Alarm')).toBe(1);
    disposeModule(module);
  });

  it('leaves a module with no events free of the runtime handle', () => {
    /* Generated code depends on nothing, and a module that neither emits nor listens should not
       acquire a hook the loader then has to call. */
    const code = compile('fn plain() -> f32 {\n    return 1\n}\n');
    expect(code).not.toContain('__runtime');
    expect(code).not.toContain('$rt');
  });

  it('gives a module that only emits the handle, since the emit needs it', () => {
    const code = compile(`${ALARM}\nfn fire() {\n    emit Alarm { strength: 1 }\n}\n`);
    expect(code).toContain('__runtime');
  });
});

describe('what an event refuses', () => {
  it('refuses emitting a record, saying only an event travels', () => {
    expect(codes('data Alarm {\n    a: f32 = 0\n}\n\nfn f() {\n    emit Alarm { a: 1 }\n}\n')).toContain(
      'DS0270',
    );
  });

  it('refuses emitting a name nothing declares', () => {
    expect(codes('fn f() {\n    emit Nowhere { }\n}\n')).toContain('DS0270');
  });

  it('refuses an `on` for an event nothing declares', () => {
    expect(codes('on Nowhere as n {\n}\n')).toContain('DS0270');
  });

  it('refuses a field the event does not have', () => {
    expect(codes(`${ALARM}\nfn f() {\n    emit Alarm { strength: 1, loudness: 2 }\n}\n`)).toContain(
      'DS0271',
    );
  });

  it('refuses a field of the wrong type', () => {
    expect(codes(`${ALARM}\nfn f() {\n    emit Alarm { strength: true }\n}\n`)).toContain('DS0271');
  });

  it('refuses omitting a field that has no default to fall back on', () => {
    expect(codes(`${ALARM}\nfn f() {\n    emit Alarm { source: 1 }\n}\n`)).toContain('DS0271');
  });

  it('accepts omitting one that has', () => {
    expect(codes(`${ALARM}\nfn f() {\n    emit Alarm { strength: 1 }\n}\n`)).toEqual([]);
  });

  it('refuses an event and a record of one name', () => {
    expect(codes('data Alarm {\n    a: f32 = 0\n}\n\nevent Alarm {\n    b: f32 = 0\n}\n')).toContain(
      'DS0209',
    );
  });

  it('types the handler binding, so a field it does not have is an ordinary error', () => {
    expect(codes(`${ALARM}\nfn use(x: f32) {\n}\n\non Alarm as alarm {\n    use(alarm.loudness)\n}\n`).length).toBeGreaterThan(0);
    expect(codes(`${ALARM}\nfn use(x: f32) {\n}\n\non Alarm as alarm {\n    use(alarm.strength)\n}\n`)).toEqual([]);
  });
});

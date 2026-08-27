import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';
import { createRegistry, defineCapability } from '../../registry/capability.ts';
import { allocationsIn } from './hot.ts';
import { parse } from '../parser.ts';
import { check } from './checker.ts';
import { lower } from '../ir/lower.ts';

const irOf = (source: string) => {
  const parsed = parse(source, 'm.drs');
  expect(parsed.diagnostics).toEqual([]);
  const checked = check(parsed.module, 'm.drs');
  expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return lower(parsed.module, checked, undefined, undefined, undefined, 'm.drs');
};

const allocations = (source: string, fn = 'f'): string[] => {
  const ir = irOf(source);
  const found = ir.fns.find((f) => f.name === fn);
  if (found === undefined) throw new Error(`no function ${fn}`);
  return allocationsIn(found).map((a) => a.what);
};

/** A registry with one capability per interesting property of a hot path. */
const registry = () => {
  const r = createRegistry();
  r.add(
    defineCapability({
      module: 'drift/audio',
      name: 'play',
      signature: 'fn(gain: f32) -> void',
      params: [{ name: 'gain', type: 'f32' }],
      returns: 'void',
      effects: ['audio.write'],
      deterministic: false,
      doc: 'Play a sound.',
      implementation: 'AudioGraph.play',
    }),
  );
  r.add(
    defineCapability({
      module: 'drift/scene',
      name: 'positionX',
      signature: 'fn(node: f32) -> f32',
      params: [{ name: 'node', type: 'f32' }],
      returns: 'f32',
      effects: ['scene.read'],
      deterministic: true,
      doc: "A node's x.",
      implementation: 'scene.positionX',
    }),
  );
  r.add(
    defineCapability({
      module: 'drift/scene',
      name: 'samples',
      signature: 'fn(node: f32) -> f32',
      params: [{ name: 'node', type: 'f32' }],
      returns: 'f32',
      effects: ['scene.read'],
      deterministic: true,
      allocates: true,
      doc: 'A view over the samples. Allocates one.',
      implementation: 'scene.samples',
    }),
  );
  return r;
};

const codes = (source: string): string[] =>
  compileDriftScript(source, {
    filename: 'm.drs',
    host: singleFileHost(),
    registry: registry(),
    mode: 'development',
  }).diagnostics.map((d) => d.code);

const messages = (source: string): string =>
  compileDriftScript(source, {
    filename: 'm.drs',
    host: singleFileHost(),
    registry: registry(),
    mode: 'development',
  })
    .diagnostics.map((d) => d.message)
    .join('\n');

describe('what allocates', () => {
  it('reports a record literal', () => {
    const found = allocations(
      'data Pulse {\n    phase: f32 = 0\n}\n\nfn f() -> Pulse {\n    return Pulse { phase: 1 }\n}\n',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('record literal');
  });

  it('reports wrapping a value in an option or a result', () => {
    expect(allocations('fn f() -> f32? {\n    return some(1)\n}\n')[0]).toContain('wraps its value');
  });

  it('does not report `none`, which is one shared constant', () => {
    expect(allocations('fn f() -> f32? {\n    return none\n}\n')).toEqual([]);
  });

  it('reports a `match`, which is emitted as a function made at the call', () => {
    /* It looks free in the source, which is exactly why it is worth naming. */
    const found = allocations(
      'enum Mode {\n    Fast\n    Slow\n}\n\nfn f(m: Mode) -> f32 {\n    return match m {\n        Fast => 1\n        Slow => 2\n    }\n}\n',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('match');
  });

  it('has no case for string building, because the language has none', () => {
    /*
     * §21 lists "arbitrary string formatting" among what `@hot` rejects, and the plan asked for a
     * test of it. It cannot be written: `+` requires numeric operands, so the type checker refuses
     * two strings as `DS0259` long before the allocation pass runs. A branch for it would be one
     * that can never be taken, which is what this asserts instead.
     */
    const { diagnostics } = compileDriftScript(
      'fn f(a: String, b: String) -> String {\n    return a + b\n}\n',
      { filename: 'm.drs', host: singleFileHost(), mode: 'development' },
    );
    expect(diagnostics.map((d) => d.code)).toContain('DS0259');
  });

  it('reports nothing for arithmetic on erased units', () => {
    /* R4's promise, checked from the other side: `30m` is `30` by the time this sees it, so there
       is no wrapper and no tag and nothing to allocate. */
    expect(allocations('fn f() -> f32 {\n    return 30m + 250ms\n}\n')).toEqual([]);
  });

  it('reports nothing for ordinary arithmetic and field reads', () => {
    expect(
      allocations(
        'data Pulse {\n    phase: f32 = 0\n}\n\nfn f(p: Pulse, dt: f32) -> f32 {\n    return p.phase * dt + 1\n}\n',
      ),
    ).toEqual([]);
  });
});

describe('`@hot`', () => {
  it('accepts a function that allocates nothing', () => {
    expect(
      codes('@hot\nfn f(a: f32, b: f32) -> f32 {\n    return a * b + 1\n}\n'),
    ).toEqual([]);
  });

  it('refuses an allocation, naming what allocates', () => {
    const source =
      'data Pulse {\n    phase: f32 = 0\n}\n\n@hot\nfn f() -> Pulse {\n    return Pulse { phase: 1 }\n}\n';
    expect(codes(source)).toContain('DS0400');
    expect(messages(source)).toContain('record literal');
  });

  it('refuses `audio.play`, which is the case the design names', () => {
    const source =
      'import { play } from "drift/audio"\n\n@hot\nfn f() {\n    audio.play(1)\n}\n';
    expect(codes(source)).toContain('DS0401');
    expect(messages(source)).toContain('audio.write');
  });

  it('accepts a scene read, because that is what a per-frame function is usually for', () => {
    expect(
      codes(
        'import { positionX } from "drift/scene"\n\n@hot\nfn f(node: f32) -> f32 {\n    return scene.positionX(node)\n}\n',
      ),
    ).toEqual([]);
  });

  it('refuses a capability that says it allocates, which is how a view is seen at all', () => {
    /*
     * `AGENTS.md` names a typed-array view as an allocation, and the language has no array type —
     * so it cannot appear in an expression. The host is the only party that knows, and `allocates`
     * on the binding is how it says.
     */
    const source =
      'import { samples } from "drift/scene"\n\n@hot\nfn f(node: f32) -> f32 {\n    return scene.samples(node)\n}\n';
    expect(codes(source)).toContain('DS0400');
    expect(messages(source)).toContain('allocates');
  });

  it('reports what it reaches through a function nobody annotated', () => {
    /* The callee is entitled to allocate — it is not annotated. The mistake is calling it here. */
    const source =
      'data Pulse {\n    phase: f32 = 0\n}\n\n' +
      'fn build() -> Pulse {\n    return Pulse { phase: 1 }\n}\n\n' +
      '@hot\nfn f() -> Pulse {\n    return build()\n}\n';
    expect(codes(source)).toContain('DS0400');
    expect(messages(source)).toContain('reaches `build`');
  });

  it('leaves an unannotated function alone, however much it allocates', () => {
    expect(
      codes(
        'data Pulse {\n    phase: f32 = 0\n}\n\nfn build() -> Pulse {\n    return Pulse { phase: 1 }\n}\n',
      ),
    ).toEqual([]);
  });

  it('composes with `@deterministic` without either weakening the other', () => {
    /* `@hot` says nothing about determinism and `@deterministic` says nothing about allocation, so
       a function carrying both has to satisfy both — and a violation of either is reported. */
    const both =
      '@hot\n@deterministic\nfn f(a: f32) -> f32 {\n    return a * 2\n}\n';
    expect(codes(both)).toEqual([]);

    const allocatesAndDeterministic =
      'data Pulse {\n    phase: f32 = 0\n}\n\n@hot\n@deterministic\nfn f() -> Pulse {\n    return Pulse { phase: 1 }\n}\n';
    expect(codes(allocatesAndDeterministic)).toContain('DS0400');

    const hotAndNondeterministic =
      'import { play } from "drift/audio"\n\n@hot\n@deterministic\nfn f() {\n    audio.play(1)\n}\n';
    const reported = codes(hotAndNondeterministic);
    expect(reported).toContain('DS0261');
  });
});

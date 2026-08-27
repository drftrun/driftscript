import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost} from './index.ts';
import { defineTarget } from '../registry/manifest.ts';

/**
 * §48 steps 12 to 15, which the design calls the whole thesis reduced to something that either
 * works or does not: a module requires a capability the target does not provide, the linker refuses
 * it in words, the manifest is changed, and **the same source links, unchanged**.
 *
 * The source is declared once and compiled twice, deliberately. Two nearly-identical literals would
 * let an edit to one drift from the other, and "the same source" is the entire claim being tested.
 */
const SOURCE = `import { blendTree } from "drift/animation"

data PulseState {
    phase: f32 = 0
}

fn update(state: mut PulseState, dt: f32) {
    state.phase += dt
}
`;

describe('a target manifest decides what links', () => {
  it('step 12 and 13: refuses a module the target does not provide, in words', () => {
    const result = compileDriftScript(SOURCE, {
      filename: 'pulse.drs',
      manifest: defineTarget('web-min', ['drift/core']),
      host: singleFileHost(),
      mode: 'development',
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('DS0301');
    expect(result.diagnostics[0].message).toContain('drift/animation');
    expect(result.diagnostics[0].message).toContain('web-min');
    expect(result.code).toBe('');
  });

  it('step 14 and 15: the same source links unchanged once the manifest provides it', () => {
    const result = compileDriftScript(SOURCE, {
      filename: 'pulse.drs',
      manifest: defineTarget('web-full', ['drift/core', 'drift/animation']),
      host: singleFileHost(),
      mode: 'development',
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('export function update');
    expect(result.metadata.requires).toEqual(['drift/animation']);
  });

  /**
   * The design's second invariant, asserted directly.
   *
   * A file using an unprovided surface **parses and type-checks**; only linking declines it. If a
   * `DS01xx` or `DS02xx` ever appears here, the language has been trimmed to what shipped this
   * month — which is the thing the whole design exists to refuse.
   */
  it('parses and type-checks identically either way, because only linking differs', () => {
    const refused = compileDriftScript(SOURCE, {
      filename: 'pulse.drs',
      manifest: defineTarget('web-min', []),
      host: singleFileHost(),
      mode: 'development',
    });
    expect(refused.diagnostics.every((d) => d.code.startsWith('DS03'))).toBe(true);
  });

  it('points the refusal at the import rather than at the top of the file', () => {
    const result = compileDriftScript(SOURCE, {
      filename: 'pulse.drs',
      manifest: defineTarget('web-min', []),
      host: singleFileHost(),
      mode: 'development',
    });
    const diagnostic = result.diagnostics[0];
    expect(SOURCE.slice(diagnostic.start, diagnostic.end)).toContain('drift/animation');
  });

  it('links a file that needs nothing against a target that provides nothing', () => {
    const result = compileDriftScript('fn hello() -> String {\n    return "hello, world"\n}\n', {
      filename: 'hello.drs',
      manifest: defineTarget('nothing', []),
      host: singleFileHost(),
      mode: 'development',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('export function hello');
  });

  it('refuses a surface nothing provides yet without blaming the language', () => {
    const result = compileDriftScript(
      'import { send } from "drift/network"\n\ndata P {\n    a: f32 = 0\n}\n',
      { filename: 'e.drs', manifest: defineTarget('web-full', ['drift/core']), host: singleFileHost(), mode: 'development' },
    );
    expect(result.diagnostics[0].message).toContain('no host provides it yet');
    expect(result.diagnostics[0].message).toContain('links when a host implements it');
  });
});

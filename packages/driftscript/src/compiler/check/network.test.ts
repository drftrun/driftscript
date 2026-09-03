/**
 * `@replicated` means something now, and these are the two things it means.
 *
 * The annotation has been a lexer token since `§22` specified it, read by nothing. What it must not
 * become is a token that is read *permissively*: an annotation that accepts anything teaches an
 * author that any field can cross a wire, and the correction arrives as a value that is nonsense on
 * another machine.
 */
import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';

const compile = (source: string) =>
  compileDriftScript(source, { filename: 'a.drs', host: singleFileHost(), mode: 'development' });

const errors = (source: string) =>
  compile(source).diagnostics.filter((d) => d.severity === 'error');

describe('@replicated', () => {
  it('is accepted on a numeric component field', () => {
    expect(
      errors('component Health {\n    @replicated\n    current: f32 = 100\n}\n'),
    ).toEqual([]);
  });

  it('is accepted on every width a packet can carry', () => {
    for (const type of ['f32', 'f64', 'i32', 'u8', 'bool', 'Entity']) {
      const source = `component C {\n    @replicated\n    v: ${type}\n}\n`;
      expect(errors(source), `${type} should be replicable`).toEqual([]);
    }
  });

  /**
   * A record passed between functions has no identity to replicate *to*, which is the difference
   * between a `data` and a `component` and the whole reason the check exists.
   */
  it('is refused on a data record, naming what to do instead', () => {
    const found = errors('data Runner {\n    @replicated\n    x: f32 = 0\n}\n');
    expect(found.length).toBe(1);
    expect(found[0]?.code).toBe('DS0298');
    expect(found[0]?.message).toContain('rather than a `component`');
    expect(found[0]?.message).toContain('no identity to replicate to');
  });

  it('is refused on a String, because a replication path carries numbers', () => {
    const found = errors('component Named {\n    @replicated\n    label: String = ""\n}\n');
    expect(found.length).toBe(1);
    expect(found[0]?.message).toContain('a replication path carries numbers');
  });

  /**
   * An optional needs a presence bit beside its value, which is a second thing to keep in step
   * across a version change and which a packet has no column for.
   */
  it('is refused on an optional, and says what to replicate instead', () => {
    const found = errors('component Target {\n    @replicated\n    of: Entity?\n}\n');
    expect(found.length).toBe(1);
    expect(found[0]?.message).toContain('presence bit');
  });

  /** An unannotated field of any type is untouched, so the check reaches only what it marks. */
  it('leaves a field alone that is not annotated', () => {
    expect(errors('component Named {\n    label: String = ""\n}\n')).toEqual([]);
    expect(errors('data Runner {\n    x: f32 = 0\n}\n')).toEqual([]);
  });

  /**
   * It registers nothing, which is what lets a file carrying it link against a target with no
   * networking. The same property `check/chemistry.ts` asserts for `@substance`.
   */
  it('needs no capability, so a file using it links against any target', () => {
    const result = compile('component Health {\n    @replicated\n    current: f32 = 100\n}\n');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('is still refused where a field takes no annotation at all', () => {
    const found = errors('component C {\n    @hot\n    v: f32\n}\n');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.message).toContain('`@replicated`');
  });
});

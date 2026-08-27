import { describe, expect, it } from 'vitest';
import { singleFileHost } from './host.ts';

describe('singleFileHost', () => {
  /*
   * It resolves nothing, and that is the feature rather than a limitation.
   *
   * `CompileOptions.host` is required, so this is how a caller says *there is no module graph here*
   * out loud. An optional host would have let the same situation be expressed by saying nothing,
   * and a file with imports would then compile to a module missing them — the silent no-op shape.
   */
  it('resolves nothing, so a relative import is refused rather than silently dropped', () => {
    expect(singleFileHost().resolve('./dog', '/x/wolf.drs')).toBeNull();
  });

  it('loads nothing', () => {
    expect(singleFileHost().load('/x/dog.drs')).toBeNull();
  });

  it('resolves nothing for a capability specifier either, because it is never asked', () => {
    /* A bare specifier is a capability and never reaches a host. Answering null rather than
       throwing keeps that true if a caller ever asks anyway. */
    expect(singleFileHost().resolve('drift/audio', '/x/wolf.drs')).toBeNull();
  });
});

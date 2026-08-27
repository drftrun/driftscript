import { describe, expect, it } from 'vitest';
import { STD_MODULES, defineTarget, providesModule } from './manifest.ts';

describe('the target manifest', () => {
  it('provides every std module without listing one', () => {
    const target = defineTarget('web-min', []);
    for (const module of STD_MODULES) {
      expect(providesModule(target, module)).toBe(true);
    }
  });

  it('provides only the drift modules it lists', () => {
    const target = defineTarget('web-min', ['drift/core', 'drift/audio']);
    expect(providesModule(target, 'drift/audio')).toBe(true);
    expect(providesModule(target, 'drift/animation')).toBe(false);
  });

  it('refuses a manifest listing a std module, because that claim is not a target\'s to make', () => {
    expect(() => defineTarget('web-min', ['std/math'])).toThrow(/std\/math/);
  });

  it('refuses a manifest listing a module under no known prefix', () => {
    expect(() => defineTarget('web-min', ['unity/scene'])).toThrow(/unity\/scene/);
  });

  it('deduplicates, so a manifest assembled from fragments reports a module once', () => {
    const target = defineTarget('web', ['drift/audio', 'drift/core', 'drift/audio']);
    expect(target.provides).toEqual(['drift/audio', 'drift/core']);
  });

  it('is usable with nothing at all, which is what makes std standard', () => {
    const bare = defineTarget('nothing', []);
    expect(providesModule(bare, 'std/core')).toBe(true);
    expect(providesModule(bare, 'drift/core')).toBe(false);
  });
});

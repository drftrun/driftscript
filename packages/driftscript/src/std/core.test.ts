import { describe, expect, it } from 'vitest';
import { identity } from './core.ts';

describe('std/core', () => {
  it('returns its argument unchanged', () => {
    const value = { phase: 0 };
    expect(identity(value)).toBe(value);
  });
});

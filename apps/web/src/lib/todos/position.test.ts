import { describe, expect, it } from '@jest/globals';
import { positionBetween } from './position';

describe('positionBetween', () => {
  it('starts in the middle of the key space', () => {
    expect(positionBetween(null, null)).toBe('i');
  });

  it('keeps keys strictly ordered across random inserts', () => {
    const keys: string[] = [];
    let seed = 7;
    for (let step = 0; step < 2000; step++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const index = seed % (keys.length + 1);
      const key = positionBetween(keys[index - 1] ?? null, keys[index] ?? null);
      keys.splice(index, 0, key);
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some(key => key.endsWith('0'))).toBe(false);
  });

  it('grows slowly under repeated prepends and appends', () => {
    let top: string | null = null;
    let bottom: string | null = null;
    for (let step = 0; step < 500; step++) {
      const nextTop = positionBetween(null, top);
      const nextBottom = positionBetween(bottom, null);
      if (top !== null) expect(nextTop < top).toBe(true);
      if (bottom !== null) expect(nextBottom > bottom).toBe(true);
      top = nextTop;
      bottom = nextBottom;
    }
    expect(top?.length).toBeLessThan(40);
    expect(bottom?.length).toBeLessThan(40);
  });

  it('rejects out-of-order and malformed keys', () => {
    expect(() => positionBetween('b', 'a')).toThrow('out of order');
    expect(() => positionBetween('a', 'a')).toThrow('out of order');
    expect(() => positionBetween('A', null)).toThrow('Invalid position key');
    expect(() => positionBetween(null, 'a0')).toThrow('Invalid position key');
  });
});

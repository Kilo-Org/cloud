import { describe, expect, it } from 'vitest';

import { hasVisibleText } from './text';

describe('hasVisibleText', () => {
  it('accepts ordinary text', () => {
    expect(hasVisibleText('Acme')).toBe(true);
    expect(hasVisibleText('  Acme  ')).toBe(true);
    expect(hasVisibleText('a')).toBe(true);
  });

  it('accepts a value whose visible letter sits between invisible ones', () => {
    expect(hasVisibleText('\u200B\u200BAcme\u200B')).toBe(true);
  });

  it('refuses an empty value and one of spaces only', () => {
    expect(hasVisibleText('')).toBe(false);
    expect(hasVisibleText('   ')).toBe(false);
    expect(hasVisibleText('\t\n')).toBe(false);
  });

  it('refuses zero-width, direction and control characters only', () => {
    expect(hasVisibleText('\u200B\u200B\u200B')).toBe(false);
    expect(hasVisibleText('\u200E\u200F\u2028\u2029')).toBe(false);
    expect(hasVisibleText('\u0000\u0007\u001B')).toBe(false);
    expect(hasVisibleText('\uFEFF')).toBe(false);
  });

  it('refuses a combining mark with no letter to draw through', () => {
    expect(hasVisibleText('\u0301\u0301')).toBe(false);
  });

  it('refuses unpaired surrogates and accepts a surrogate pair', () => {
    expect(hasVisibleText('\uD800')).toBe(false);
    expect(hasVisibleText('\uDC00\uD800')).toBe(false);
    expect(hasVisibleText('\uD83D\uDE00')).toBe(true);
  });

  it('refuses the fillers that are letters or symbols by category', () => {
    expect(hasVisibleText('\u115F\u1160')).toBe(false);
    expect(hasVisibleText('\u2800\u3164\uFFA0')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { formatShortModelDisplayName } from './model-display-name';

describe('formatShortModelDisplayName', () => {
  it('drops the vendor prefix the catalog repeats in the display name', () => {
    expect(formatShortModelDisplayName('DeepSeek: DeepSeek V4 Flash 0731')).toBe(
      'DeepSeek V4 Flash 0731'
    );
  });

  it('strips the prefix from the reported DeepSeek V4.1 Flash catalogue name', () => {
    expect(formatShortModelDisplayName('DeepSeek: DeepSeek V4.1 Flash')).toBe(
      'DeepSeek V4.1 Flash'
    );
  });

  it('keeps a name that carries no vendor prefix', () => {
    expect(formatShortModelDisplayName('GPT-4o')).toBe('GPT-4o');
  });

  it('keeps an empty name empty', () => {
    expect(formatShortModelDisplayName('')).toBe('');
  });
});

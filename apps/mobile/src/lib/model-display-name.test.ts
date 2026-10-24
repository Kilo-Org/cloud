import { describe, expect, it } from 'vitest';

import { formatShortModelDisplayName, resolveCatalogModelName } from './model-display-name';

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

describe('resolveCatalogModelName', () => {
  const catalog = [{ id: '~deepseek/deepseek-flash-latest', name: 'DeepSeek Flash Latest' }];

  it('uses the catalogue name the model picker shows for the same id', () => {
    expect(resolveCatalogModelName('~deepseek/deepseek-flash-latest', catalog)).toBe(
      'DeepSeek Flash Latest'
    );
  });

  it('falls back to the model segment without the alias marker when the catalogue has no entry', () => {
    expect(resolveCatalogModelName('~deepseek/deepseek-flash-latest', [])).toBe(
      'deepseek flash latest'
    );
  });

  it('matches ids exactly, so another model keeps its own fallback', () => {
    expect(
      resolveCatalogModelName('deepseek/deepseek-flash-latest', [
        { id: '~deepseek/deepseek-flash-latest', name: 'DeepSeek Flash Latest' },
      ])
    ).toBe('deepseek flash latest');
  });

  it('drops a vendor prefix carried by a stored display name', () => {
    expect(resolveCatalogModelName('DeepSeek: DeepSeek V4.1 Flash', [])).toBe(
      'DeepSeek V4.1 Flash'
    );
  });

  it('keeps an id with no path or alias marker', () => {
    expect(resolveCatalogModelName('~kilo-auto', [])).toBe('kilo auto');
  });
});

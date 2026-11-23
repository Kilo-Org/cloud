import { describe, expect, it } from 'vitest';

import {
  formatShortModelDisplayName,
  modelReferenceLabel,
  resolveCatalogModelName,
} from './model-display-name';

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

describe('modelReferenceLabel', () => {
  it('shows the readable last segment of a vendor-scoped id', () => {
    expect(modelReferenceLabel('deepseek/deepseek-v4.1-flash-1017')).toBe(
      'deepseek v4.1 flash 1017'
    );
  });

  it('drops the latest-alias marker with the path', () => {
    expect(modelReferenceLabel('~deepseek/deepseek-v4-flash-latest')).toBe(
      'deepseek v4 flash latest'
    );
  });

  it('keeps a value that carries no slash, since it is already a name', () => {
    expect(modelReferenceLabel('custom-model-id')).toBe('custom-model-id');
  });

  it('keeps an empty reference empty', () => {
    expect(modelReferenceLabel('')).toBe('');
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

  it('strips the alias marker from a bare alias id and spaces its hyphens', () => {
    expect(resolveCatalogModelName('~kilo-auto', [])).toBe('kilo auto');
  });
});

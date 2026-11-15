import { describe, expect, test } from '@jest/globals';
import {
  ADD_BYOK_PROVIDERS,
  BYOK_PROVIDERS,
  DIRECT_BYOK_PROVIDERS_LIST,
  getByokProviderDisplayName,
} from './provider-names';

const legacyOnlyName = 'Legacy Codestral-only key';

describe('BYOK provider lists', () => {
  test('lists the legacy Codestral-only key exactly once', () => {
    expect(BYOK_PROVIDERS.filter(provider => provider.id === 'codestral')).toEqual([
      { id: 'codestral', name: legacyOnlyName },
    ]);
  });

  test('subtracts the legacy-only key from the addable list', () => {
    expect(ADD_BYOK_PROVIDERS.some(provider => provider.id === 'codestral')).toBe(false);
    expect(ADD_BYOK_PROVIDERS).toHaveLength(BYOK_PROVIDERS.length - 1);
  });

  test('does not offer the legacy-only key as a direct provider', () => {
    expect(DIRECT_BYOK_PROVIDERS_LIST.some(provider => provider.id === 'codestral')).toBe(false);
  });

  test('names every row and lists each id once', () => {
    const allRows = [...BYOK_PROVIDERS, ...ADD_BYOK_PROVIDERS, ...DIRECT_BYOK_PROVIDERS_LIST];
    for (const provider of allRows) {
      expect(provider.name.length).toBeGreaterThan(0);
    }
    const ids = BYOK_PROVIDERS.map(provider => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('sorts every provider by name', () => {
    const sorted = [...BYOK_PROVIDERS].sort((a, b) => a.name.localeCompare(b.name));
    expect(BYOK_PROVIDERS).toEqual(sorted);
  });

  test('resolves a display name and falls back to the id itself', () => {
    expect(getByokProviderDisplayName('codestral')).toBe(legacyOnlyName);
    expect(getByokProviderDisplayName('not-a-provider')).toBe('not-a-provider');
  });
});

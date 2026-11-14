import { type TFunction } from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { sessionListNoMatchDescription } from './session-list-empty-copy';

const t = i18n.t as TFunction;

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('sessionListNoMatchDescription', () => {
  it.each([
    {
      name: 'a search alone',
      isSearching: true,
      hasActiveFilters: false,
      expected: 'Try a different search term.',
    },
    {
      name: 'a filter alone',
      isSearching: false,
      hasActiveFilters: true,
      expected: 'Try adjusting or clearing your filters.',
    },
    {
      name: 'a search and a filter together',
      isSearching: true,
      hasActiveFilters: true,
      expected: 'Try a different search term. Try adjusting or clearing your filters.',
    },
  ])('names every active cause for $name', test => {
    expect(
      sessionListNoMatchDescription(t, {
        isSearching: test.isSearching,
        hasActiveFilters: test.hasActiveFilters,
      })
    ).toBe(test.expected);
  });

  // The copy follows the reader's language, so the composed sentence must come
  // from the active catalog rather than a fixed English pair.
  it('composes the sentences of the active language', async () => {
    await i18n.changeLanguage('id');
    const composed = sessionListNoMatchDescription(t, {
      isSearching: true,
      hasActiveFilters: true,
    });
    expect(composed).toBe(
      `${i18n.t('agents.sessionList.tryDifferentSearch')} ${i18n.t('agents.sessionList.tryAdjustFilters')}`
    );
    expect(composed).not.toContain('Try a different search term.');
  });
});

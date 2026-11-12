import { type TFunction } from 'i18next';

/**
 * The no-match body's description for the inputs that narrow the list.
 *
 * A search term, a platform or project filter, and the transient status filter
 * can each hide a session on their own, so the copy names every one that is
 * active. Both empty states share this rule, and both compose it from the same
 * two catalog sentences, so the bodies cannot drift apart when a cause is added
 * or its message changes.
 */
export function sessionListNoMatchDescription(
  t: TFunction,
  causes: Readonly<{ isSearching: boolean; hasActiveFilters: boolean }>
): string {
  const filterHint = t('agents.sessionList.tryAdjustFilters');
  if (!causes.isSearching) {
    return filterHint;
  }
  const searchHint = t('agents.sessionList.tryDifferentSearch');
  return causes.hasActiveFilters ? `${searchHint} ${filterHint}` : searchHint;
}

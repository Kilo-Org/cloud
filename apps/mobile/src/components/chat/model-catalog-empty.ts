/** The catalog tabs: models this device fits, or every listed model. */
export type CatalogTab = 'fits' | 'all';

export type CatalogEmptyCopy = {
  readonly titleKey:
    | 'modelChat.catalog.noFits'
    | 'modelChat.catalog.noResults'
    | 'modelChat.catalog.noResultsForQuery';
  readonly descriptionKey?: 'modelChat.catalog.noFitsDescription';
};

/**
 * The copy an empty result list shows. A search that finds nothing names the
 * query on both tabs. The fit hint appears only when the same search without
 * the device cap finds models: with no query the Fits tab is empty because
 * nothing fits, and with a query an empty capped answer alone cannot tell
 * "no match" from "matched, but too large".
 */
export function catalogEmptyCopy(input: {
  readonly tab: CatalogTab;
  readonly query: string;
  readonly widerMatch: boolean;
}): CatalogEmptyCopy {
  if (input.query === '') {
    return input.tab === 'fits'
      ? {
          titleKey: 'modelChat.catalog.noFits',
          descriptionKey: 'modelChat.catalog.noFitsDescription',
        }
      : { titleKey: 'modelChat.catalog.noResults' };
  }
  if (input.tab === 'fits' && input.widerMatch) {
    return {
      titleKey: 'modelChat.catalog.noResultsForQuery',
      descriptionKey: 'modelChat.catalog.noFitsDescription',
    };
  }
  return { titleKey: 'modelChat.catalog.noResultsForQuery' };
}

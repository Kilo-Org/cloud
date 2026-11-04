import { describe, expect, it } from 'vitest';

import { catalogEmptyCopy } from './model-catalog-empty';

describe('catalog empty copy', () => {
  it('keeps the fit copy for an empty search on the fits tab', () => {
    expect(catalogEmptyCopy({ tab: 'fits', query: '', widerMatch: false })).toEqual({
      titleKey: 'modelChat.catalog.noFits',
      descriptionKey: 'modelChat.catalog.noFitsDescription',
    });
  });

  it('keeps the plain no-results copy for an empty search on the all tab', () => {
    expect(catalogEmptyCopy({ tab: 'all', query: '', widerMatch: false })).toEqual({
      titleKey: 'modelChat.catalog.noResults',
    });
  });

  it('names the search on the fits tab when nothing matches even without the cap', () => {
    expect(catalogEmptyCopy({ tab: 'fits', query: 'zzzzqqq', widerMatch: false })).toEqual({
      titleKey: 'modelChat.catalog.noResultsForQuery',
    });
  });

  it('names the search on the all tab', () => {
    expect(catalogEmptyCopy({ tab: 'all', query: 'zzzzqqq', widerMatch: false })).toEqual({
      titleKey: 'modelChat.catalog.noResultsForQuery',
    });
  });

  it('points to the all tab when the cap is what hid the matches', () => {
    expect(catalogEmptyCopy({ tab: 'fits', query: 'qwen3-32b', widerMatch: true })).toEqual({
      titleKey: 'modelChat.catalog.noResultsForQuery',
      descriptionKey: 'modelChat.catalog.noFitsDescription',
    });
  });

  it('never offers the fit hint on the all tab', () => {
    expect(catalogEmptyCopy({ tab: 'all', query: 'qwen3-32b', widerMatch: true })).toEqual({
      titleKey: 'modelChat.catalog.noResultsForQuery',
    });
  });
});

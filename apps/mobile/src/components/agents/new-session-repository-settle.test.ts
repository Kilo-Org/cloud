import { describe, expect, it } from 'vitest';

import { isRepositoryRegionSettled } from './new-session-repository-settle';

describe('isRepositoryRegionSettled', () => {
  /** Every input final: a provider answered, no selection is still to arrive. */
  const settled = {
    providerQueriesResolved: true,
    connectCtasLoaded: true,
    draftSettled: true,
    seedPending: false,
    storedSelectionGone: false,
  };

  it('reports the region settled once every input is final', () => {
    expect(isRepositoryRegionSettled(settled)).toBe(true);
  });

  it('holds the region while a provider query is still in flight', () => {
    expect(isRepositoryRegionSettled({ ...settled, providerQueriesResolved: false })).toBe(false);
  });

  it('holds the region until the persisted collapse list has been read', () => {
    expect(isRepositoryRegionSettled({ ...settled, connectCtasLoaded: false })).toBe(false);
  });

  it('holds the region until the repository draft has loaded', () => {
    expect(isRepositoryRegionSettled({ ...settled, draftSettled: false })).toBe(false);
  });

  it('holds the region while a seed is still due, so the card never paints expanded and collapses', () => {
    expect(isRepositoryRegionSettled({ ...settled, seedPending: true })).toBe(false);
  });

  it('holds the region while a stored selection is still to be dropped', () => {
    expect(isRepositoryRegionSettled({ ...settled, storedSelectionGone: true })).toBe(false);
  });
});

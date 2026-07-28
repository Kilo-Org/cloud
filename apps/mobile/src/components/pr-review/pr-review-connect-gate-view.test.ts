import { describe, expect, it } from 'vitest';

import {
  type PrReviewGateView,
  selectPrReviewGateView,
  type SelectPrReviewGateViewInput,
} from './pr-review-connect-gate-view';

const base: SelectPrReviewGateViewInput = {
  isError: false,
  isLoading: false,
  connected: true,
  revoked: false,
};

function viewFor(patch: Partial<SelectPrReviewGateViewInput>): PrReviewGateView {
  return selectPrReviewGateView({ ...base, ...patch });
}

describe('selectPrReviewGateView', () => {
  it('returns loading while the query is loading', () => {
    expect(viewFor({ isLoading: true })).toBe('loading');
  });

  it('returns error when the query failed and is not loading', () => {
    expect(viewFor({ isError: true })).toBe('error');
  });

  it('returns error when both error and loading are true', () => {
    expect(selectPrReviewGateView({ ...base, isError: true, isLoading: true })).toBe('error');
  });

  it('returns connect when not connected and not revoked', () => {
    expect(viewFor({ connected: false })).toBe('connect');
  });

  it('returns reconnect when the connection was revoked', () => {
    expect(viewFor({ connected: false, revoked: true })).toBe('reconnect');
  });

  it('returns children when connected', () => {
    expect(viewFor({ connected: true })).toBe('children');
  });

  it('exposes only one happy view and four non-happy header-bearing views', () => {
    const inputs: Partial<SelectPrReviewGateViewInput>[] = [
      { isLoading: true },
      { isError: true },
      { connected: false },
      { connected: false, revoked: true },
      { connected: true },
    ];
    const views = inputs.map(patch => viewFor(patch));
    expect(views.filter(view => view === 'children')).toHaveLength(1);
    expect(views.filter(view => view !== 'children')).toHaveLength(4);
    expect(new Set(views).size).toBe(views.length);
  });
});

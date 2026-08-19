import { describe, expect, it } from 'vitest';

import { selectDiscussionTabView } from './pr-review-discussion-tab-view';

const base = {
  firstPageErrorState: null,
  isPending: false,
  isEmpty: false,
};

describe('selectDiscussionTabView', () => {
  it('returns permission for a permission first-page error', () => {
    expect(
      selectDiscussionTabView({ ...base, firstPageErrorState: { kind: 'permission' } })
    ).toEqual({ kind: 'permission' });
  });

  it('returns not-found for a not-found first-page error', () => {
    expect(
      selectDiscussionTabView({ ...base, firstPageErrorState: { kind: 'not-found' } })
    ).toEqual({ kind: 'not-found' });
  });

  it('returns reconnect for a reconnect first-page error', () => {
    expect(
      selectDiscussionTabView({ ...base, firstPageErrorState: { kind: 'reconnect' } })
    ).toEqual({ kind: 'reconnect' });
  });

  it('returns retryable for a retryable first-page error', () => {
    expect(
      selectDiscussionTabView({ ...base, firstPageErrorState: { kind: 'retryable' } })
    ).toEqual({ kind: 'retryable' });
  });

  it('returns loading while the first page is pending', () => {
    expect(selectDiscussionTabView({ ...base, isPending: true })).toEqual({ kind: 'loading' });
  });

  it('returns empty when there is no error, no pending, and no items', () => {
    expect(selectDiscussionTabView({ ...base, isEmpty: true })).toEqual({ kind: 'empty' });
  });

  it('returns happy when there is no error, no pending, and items exist', () => {
    expect(selectDiscussionTabView(base)).toEqual({ kind: 'happy' });
  });

  it('prioritizes the error state over pending and empty', () => {
    expect(
      selectDiscussionTabView({
        firstPageErrorState: { kind: 'permission' },
        isPending: true,
        isEmpty: true,
      })
    ).toEqual({ kind: 'permission' });
  });

  it('prioritizes pending over empty', () => {
    expect(selectDiscussionTabView({ ...base, isPending: true, isEmpty: true })).toEqual({
      kind: 'loading',
    });
  });
});

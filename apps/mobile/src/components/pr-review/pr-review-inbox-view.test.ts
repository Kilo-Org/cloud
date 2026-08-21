import { describe, expect, it } from 'vitest';

import { selectPrInboxView } from './pr-review-inbox-view';

function state(kind: 'retryable' | 'permission' | 'not-found' | 'reconnect') {
  return { kind };
}

describe('selectPrInboxView', () => {
  it('selects loading when the first page is still in flight', () => {
    expect(
      selectPrInboxView({
        isLoading: true,
        itemCount: 0,
        firstPageErrorState: null,
        laterPageError: false,
      })
    ).toEqual({ kind: 'loading', showLoadMoreRetry: false });
  });

  it('selects happy when rows are loaded', () => {
    expect(
      selectPrInboxView({
        isLoading: false,
        itemCount: 3,
        firstPageErrorState: null,
        laterPageError: false,
      })
    ).toEqual({ kind: 'happy', showLoadMoreRetry: false });
  });

  it('selects empty when no rows and no error', () => {
    expect(
      selectPrInboxView({
        isLoading: false,
        itemCount: 0,
        firstPageErrorState: null,
        laterPageError: false,
      })
    ).toEqual({ kind: 'empty', showLoadMoreRetry: false });
  });

  it('selects retryable for a transient first-page error', () => {
    expect(
      selectPrInboxView({
        isLoading: false,
        itemCount: 0,
        firstPageErrorState: state('retryable'),
        laterPageError: false,
      })
    ).toEqual({ kind: 'retryable', showLoadMoreRetry: false });
  });

  it('selects permission for a FORBIDDEN first-page error', () => {
    expect(
      selectPrInboxView({
        isLoading: false,
        itemCount: 0,
        firstPageErrorState: state('permission'),
        laterPageError: false,
      })
    ).toEqual({ kind: 'permission', showLoadMoreRetry: false });
  });

  it('selects not-found for a NOT_FOUND first-page error', () => {
    expect(
      selectPrInboxView({
        isLoading: false,
        itemCount: 0,
        firstPageErrorState: state('not-found'),
        laterPageError: false,
      })
    ).toEqual({ kind: 'not-found', showLoadMoreRetry: false });
  });

  it('selects reconnect for a PRECONDITION_FAILED first-page error', () => {
    expect(
      selectPrInboxView({
        isLoading: false,
        itemCount: 0,
        firstPageErrorState: state('reconnect'),
        laterPageError: false,
      })
    ).toEqual({ kind: 'reconnect', showLoadMoreRetry: false });
  });

  it('flags the load-more retry row only on a later-page failure with rows loaded', () => {
    expect(
      selectPrInboxView({
        isLoading: false,
        itemCount: 5,
        firstPageErrorState: null,
        laterPageError: true,
      })
    ).toEqual({ kind: 'happy', showLoadMoreRetry: true });
  });

  it('never flags the load-more retry row outside the happy state', () => {
    expect(
      selectPrInboxView({
        isLoading: true,
        itemCount: 0,
        firstPageErrorState: null,
        laterPageError: true,
      })
    ).toEqual({ kind: 'loading', showLoadMoreRetry: false });
  });
});

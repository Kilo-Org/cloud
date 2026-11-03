import { describe, expect, it } from 'vitest';

import { isOrganizationAccessView, selectPrInboxView } from './pr-review-inbox-view';

function state(kind: 'retryable' | 'permission' | 'not-found' | 'reconnect') {
  return { kind };
}

// The four-state matrix plus a later-page failure. `isPending` is "no rows and
// no first-page failure", `isFetching` is "a first-page read is in flight";
// every combination of the two has a state of its own, so no query state can
// land outside the render tree. The organization scope is granted unless a test
// says otherwise, so every case here asserts one axis at a time.
const idle = {
  itemCount: 0,
  firstPageErrorState: null,
  laterPageError: false,
  organizationScopeAccess: 'granted',
} as const;

describe('selectPrInboxView', () => {
  it('selects loading when the first page is still in flight', () => {
    expect(selectPrInboxView({ ...idle, isPending: true, isFetching: true })).toEqual({
      kind: 'loading',
      showLoadMoreRetry: false,
    });
  });

  it('selects happy when rows are loaded', () => {
    expect(
      selectPrInboxView({
        ...idle,
        isPending: false,
        isFetching: false,
        itemCount: 3,
      })
    ).toEqual({ kind: 'happy', showLoadMoreRetry: false });
  });

  it('selects empty when no rows and no error', () => {
    expect(selectPrInboxView({ ...idle, isPending: false, isFetching: false })).toEqual({
      kind: 'empty',
      showLoadMoreRetry: false,
    });
  });

  // A first read that is pending but not fetching never settles on its own:
  // the query is paused (the device reports itself offline), cancelled, or
  // never started. The skeleton would sit there with nothing to press, so the
  // retryable body owns it — nothing loaded, nothing was reported empty.
  it('selects the retryable body for a first read that cannot progress', () => {
    expect(selectPrInboxView({ ...idle, isPending: true, isFetching: false })).toEqual({
      kind: 'retryable',
      showLoadMoreRetry: false,
    });
  });

  it('keeps the skeleton for a paused first read while its retry is fetching', () => {
    expect(selectPrInboxView({ ...idle, isPending: true, isFetching: true })).toEqual({
      kind: 'loading',
      showLoadMoreRetry: false,
    });
  });

  it('selects retryable when no rows loaded and a provider failed', () => {
    // A GitLab/Bitbucket outage beside an empty GitHub inbox must not render
    // "No review requests": the failure owns the surface and its retry CTA.
    expect(
      selectPrInboxView({
        ...idle,
        isPending: false,
        isFetching: false,
        laterPageError: true,
      })
    ).toEqual({ kind: 'retryable', showLoadMoreRetry: false });
  });

  it('selects retryable for a transient first-page error', () => {
    expect(
      selectPrInboxView({
        ...idle,
        isPending: false,
        isFetching: false,
        firstPageErrorState: state('retryable'),
      })
    ).toEqual({ kind: 'retryable', showLoadMoreRetry: false });
  });

  it('keeps the failure state while the retry is fetching', () => {
    // Retry refetches a query that still has no data, so it reports pending →
    // re-entering the skeleton would replace the reason and its Retry with a
    // body the user cannot act on until the read finishes.
    expect(
      selectPrInboxView({
        ...idle,
        isPending: true,
        isFetching: true,
        firstPageErrorState: state('retryable'),
      })
    ).toEqual({ kind: 'retryable', showLoadMoreRetry: false });
  });

  it('selects permission for a FORBIDDEN first-page error', () => {
    expect(
      selectPrInboxView({
        ...idle,
        isPending: false,
        isFetching: false,
        firstPageErrorState: state('permission'),
      })
    ).toEqual({ kind: 'permission', showLoadMoreRetry: false });
  });

  it('selects not-found for a NOT_FOUND first-page error', () => {
    expect(
      selectPrInboxView({
        ...idle,
        isPending: false,
        isFetching: false,
        firstPageErrorState: state('not-found'),
      })
    ).toEqual({ kind: 'not-found', showLoadMoreRetry: false });
  });

  it('selects reconnect for a PRECONDITION_FAILED first-page error', () => {
    expect(
      selectPrInboxView({
        ...idle,
        isPending: false,
        isFetching: false,
        firstPageErrorState: state('reconnect'),
      })
    ).toEqual({ kind: 'reconnect', showLoadMoreRetry: false });
  });

  it('flags the load-more retry row only on a later-page failure with rows loaded', () => {
    expect(
      selectPrInboxView({
        ...idle,
        isPending: false,
        isFetching: false,
        itemCount: 5,
        laterPageError: true,
      })
    ).toEqual({ kind: 'happy', showLoadMoreRetry: true });
  });

  it('never flags the load-more retry row outside the happy state', () => {
    expect(
      selectPrInboxView({
        ...idle,
        isPending: true,
        isFetching: true,
        laterPageError: true,
      })
    ).toEqual({ kind: 'loading', showLoadMoreRetry: false });
  });

  it('keeps rows on screen while another provider is still pending', () => {
    // A provider that only just became enabled must not send rendered rows
    // back to skeletons; `isPending` already excludes that case, and the
    // selector must not reintroduce it through `isFetching`.
    expect(
      selectPrInboxView({
        ...idle,
        isPending: false,
        isFetching: true,
        itemCount: 2,
      })
    ).toEqual({ kind: 'happy', showLoadMoreRetry: false });
  });
});

// A refused organization denies the reads every provider state describes, so it
// outranks them: none of these provider facts may hide it.
describe('selectPrInboxView organization access', () => {
  it.each([
    ['denied', 'access-denied'],
    ['not-found', 'organization-unavailable'],
  ] as const)('reports a %s organization as %s', (access, kind) => {
    expect(
      selectPrInboxView({
        isPending: false,
        isFetching: false,
        itemCount: 0,
        firstPageErrorState: null,
        laterPageError: false,
        organizationScopeAccess: access,
      })
    ).toEqual({ kind, showLoadMoreRetry: false });
  });

  it('outranks cached rows, a provider failure and the loading state', () => {
    const rowsView = selectPrInboxView({
      isPending: false,
      isFetching: false,
      itemCount: 4,
      firstPageErrorState: null,
      laterPageError: true,
      organizationScopeAccess: 'denied',
    });
    expect(rowsView).toEqual({
      kind: 'access-denied',
      showLoadMoreRetry: false,
    });

    // A refused organization is not a transient outage: the retryable view (and
    // its Retry CTA) must not replace it, whichever provider also failed.
    expect(
      selectPrInboxView({
        isPending: false,
        isFetching: false,
        itemCount: 0,
        firstPageErrorState: state('retryable'),
        laterPageError: true,
        organizationScopeAccess: 'denied',
      })
    ).toEqual({ kind: 'access-denied', showLoadMoreRetry: false });

    // Nor is it "GitLab needs reconnecting": that asks for a credential fix the
    // reader cannot perform for an organization they lost.
    expect(
      selectPrInboxView({
        isPending: true,
        isFetching: true,
        itemCount: 0,
        firstPageErrorState: state('reconnect'),
        laterPageError: false,
        organizationScopeAccess: 'denied',
      })
    ).toEqual({ kind: 'access-denied', showLoadMoreRetry: false });
  });

  it('outranks a first read that cannot progress', () => {
    // The paused-read retryable body offers a Retry; a lost organization can
    // never answer it, so the access state still owns the surface.
    expect(
      selectPrInboxView({
        ...idle,
        isPending: true,
        isFetching: false,
        organizationScopeAccess: 'denied',
      })
    ).toEqual({ kind: 'access-denied', showLoadMoreRetry: false });
  });

  it('marks only those two views as organization access states', () => {
    expect(
      isOrganizationAccessView({
        kind: 'access-denied',
        showLoadMoreRetry: false,
      })
    ).toBe(true);
    expect(
      isOrganizationAccessView({
        kind: 'organization-unavailable',
        showLoadMoreRetry: false,
      })
    ).toBe(true);
    for (const kind of ['happy', 'empty', 'retryable', 'reconnect', 'not-found'] as const) {
      expect(isOrganizationAccessView({ kind, showLoadMoreRetry: false })).toBe(false);
    }
  });
});

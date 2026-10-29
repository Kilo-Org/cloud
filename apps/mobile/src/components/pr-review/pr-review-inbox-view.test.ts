import { describe, expect, it } from 'vitest';

import { isOrganizationAccessView, selectPrInboxView } from './pr-review-inbox-view';

function state(kind: 'retryable' | 'permission' | 'not-found' | 'reconnect') {
  return { kind };
}

// The organization scope is granted unless a test says otherwise, so every
// pre-existing case keeps asserting the provider matrix alone.
const granted = 'granted' as const;

describe('selectPrInboxView', () => {
  it('selects loading when the first page is still in flight', () => {
    expect(
      selectPrInboxView({
        isLoading: true,
        itemCount: 0,
        firstPageErrorState: null,
        laterPageError: false,
        organizationScopeAccess: granted,
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
        organizationScopeAccess: granted,
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
        organizationScopeAccess: granted,
      })
    ).toEqual({ kind: 'empty', showLoadMoreRetry: false });
  });

  it('selects retryable when no rows loaded and a provider failed', () => {
    // A GitLab/Bitbucket outage beside an empty GitHub inbox must not render
    // "No review requests": the failure owns the surface and its retry CTA.
    expect(
      selectPrInboxView({
        isLoading: false,
        itemCount: 0,
        firstPageErrorState: null,
        laterPageError: true,
        organizationScopeAccess: granted,
      })
    ).toEqual({ kind: 'retryable', showLoadMoreRetry: false });
  });

  it('selects retryable for a transient first-page error', () => {
    expect(
      selectPrInboxView({
        isLoading: false,
        itemCount: 0,
        firstPageErrorState: state('retryable'),
        laterPageError: false,
        organizationScopeAccess: granted,
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
        organizationScopeAccess: granted,
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
        organizationScopeAccess: granted,
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
        organizationScopeAccess: granted,
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
        organizationScopeAccess: granted,
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
        organizationScopeAccess: granted,
      })
    ).toEqual({ kind: 'loading', showLoadMoreRetry: false });
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
        isLoading: false,
        itemCount: 0,
        firstPageErrorState: null,
        laterPageError: false,
        organizationScopeAccess: access,
      })
    ).toEqual({ kind, showLoadMoreRetry: false });
  });

  it('outranks cached rows, a provider failure and the loading state', () => {
    const rowsView = selectPrInboxView({
      isLoading: false,
      itemCount: 4,
      firstPageErrorState: null,
      laterPageError: true,
      organizationScopeAccess: 'denied',
    });
    expect(rowsView).toEqual({ kind: 'access-denied', showLoadMoreRetry: false });

    // A refused organization is not a transient outage: the retryable view (and
    // its Retry CTA) must not replace it, whichever provider also failed.
    expect(
      selectPrInboxView({
        isLoading: false,
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
        isLoading: true,
        itemCount: 0,
        firstPageErrorState: state('reconnect'),
        laterPageError: false,
        organizationScopeAccess: 'denied',
      })
    ).toEqual({ kind: 'access-denied', showLoadMoreRetry: false });
  });

  it('marks only those two views as organization access states', () => {
    expect(isOrganizationAccessView({ kind: 'access-denied', showLoadMoreRetry: false })).toBe(
      true
    );
    expect(
      isOrganizationAccessView({ kind: 'organization-unavailable', showLoadMoreRetry: false })
    ).toBe(true);
    for (const kind of ['happy', 'empty', 'retryable', 'reconnect', 'not-found'] as const) {
      expect(isOrganizationAccessView({ kind, showLoadMoreRetry: false })).toBe(false);
    }
  });
});

// Access and read states for the PR-review inbox list: the empty view, the
// retryable later-page failure, the provider-aware reconnect notice, and a
// first read that cannot progress.

import { beforeEach, describe, expect, it } from 'vitest';

import { inboxState, insetsState, mountInboxList } from './pr-review-inbox-list.test-helpers';

describe('PrReviewInboxList states', () => {
  beforeEach(() => {
    insetsState.top = 0;
    insetsState.bottom = 0;
    insetsState.left = 0;
    insetsState.right = 0;
    inboxState.query.isPending = false;
    inboxState.query.isFetching = false;
    inboxState.query.hasNextPage = false;
    inboxState.query.isFetchingNextPage = false;
    inboxState.items = [];
    inboxState.firstPageErrorState = null;
    inboxState.firstPageErrorPlatform = null;
    inboxState.organizationId = null;
    inboxState.laterPageError = false;
  });

  it('shows the empty state and the retryable failure in their states', () => {
    let renderer = mountInboxList();
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(1);

    inboxState.laterPageError = true;
    renderer = mountInboxList();
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(1);
  });

  // The explorer saw an organization member's inbox say "Access denied" when
  // the organization's GitLab connection needed reconnecting: the reconnect
  // state must name THAT provider and its organization, because the notice's
  // connection check has no route scope on this provider-neutral surface and
  // would otherwise re-check GitHub, which cannot fix a GitLab connection.
  it('passes the failing provider and the organization to the reconnect notice', () => {
    inboxState.firstPageErrorState = { kind: 'reconnect' };
    inboxState.firstPageErrorPlatform = 'gitlab';
    inboxState.organizationId = 'org-1';
    const renderer = mountInboxList();

    const notices = renderer.root.findAll(node => String(node.type) === 'PrReviewReconnectNotice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.props).toMatchObject({ platform: 'gitlab', organizationId: 'org-1' });
    // The permission view is the state this fix removes for an organization
    // member's own inbox.
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
  });

  // A pending first read that is not fetching (offline, paused, cancelled)
  // never settles on its own: it takes the retryable body so the user can
  // restart the read, never the skeleton and never a false empty state.
  it('gives a first read that cannot progress the retry action', () => {
    inboxState.query.isPending = true;
    inboxState.query.isFetching = false;
    const bodies = mountInboxList().root.findAll(n => String(n.type) === 'QueryError');
    expect(bodies).toHaveLength(1);
  });
});

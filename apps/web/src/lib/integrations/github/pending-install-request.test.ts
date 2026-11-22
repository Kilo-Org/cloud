import { describe, expect, test } from '@jest/globals';
import type { GitHubInstallationRequest } from '@/lib/integrations/platforms/github/adapter';
import { selectInstallRequest } from './pending-install-request';

function request(accountId: string): GitHubInstallationRequest {
  return {
    id: `request-${accountId}`,
    accountId,
    accountLogin: `login-${accountId}`,
    requesterId: 'requester-1',
    requesterLogin: 'requester',
  };
}

describe('selectInstallRequest', () => {
  test('reports already_recorded when the only request is one the owner holds', () => {
    const held = request('account-held');

    expect(
      selectInstallRequest({
        requesterRequests: [held],
        ownerRecordedAccountIds: new Set(['account-held']),
      })
    ).toEqual({ kind: 'already_recorded', request: held });
  });

  test('reports the first request the owner holds when two are recorded', () => {
    const first = request('account-first');
    const second = request('account-second');

    expect(
      selectInstallRequest({
        requesterRequests: [first, second],
        ownerRecordedAccountIds: new Set(['account-first', 'account-second']),
      })
    ).toEqual({ kind: 'already_recorded', request: first });
  });

  test('reports no_outstanding_request when the requester has no request', () => {
    expect(
      selectInstallRequest({ requesterRequests: [], ownerRecordedAccountIds: new Set() })
    ).toEqual({ kind: 'unidentified', reason: 'no_outstanding_request' });
  });

  test('records the only unrecorded request', () => {
    const only = request('account-only');

    expect(
      selectInstallRequest({ requesterRequests: [only], ownerRecordedAccountIds: new Set() })
    ).toEqual({ kind: 'record', request: only });
  });

  test('records an unrecorded request next to a request the owner holds', () => {
    const held = request('account-held');
    const fresh = request('account-fresh');

    expect(
      selectInstallRequest({
        requesterRequests: [held, fresh],
        ownerRecordedAccountIds: new Set(['account-held']),
      })
    ).toEqual({ kind: 'record', request: fresh });
  });

  test('records the account when the owner set is empty and another owner holds it', () => {
    const shared = request('account-shared-by-another-owner');

    expect(
      selectInstallRequest({ requesterRequests: [shared], ownerRecordedAccountIds: new Set() })
    ).toEqual({ kind: 'record', request: shared });
  });

  test('reports ambiguous_request when two requests are unrecorded', () => {
    const first = request('account-first');
    const second = request('account-second');

    expect(
      selectInstallRequest({
        requesterRequests: [first, second],
        ownerRecordedAccountIds: new Set(),
      })
    ).toEqual({ kind: 'unidentified', reason: 'ambiguous_request' });
  });
});

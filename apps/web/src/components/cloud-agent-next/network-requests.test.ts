import { describe, expect, it } from '@jest/globals';
import type { EnvironmentSetupNetworkRequest } from '@kilocode/cloud-agent-profile';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import {
  allHostsDecided,
  childKiloSessionIdFor,
  networkDecisionLists,
  pendingNetworkRequests,
} from './network-requests';

function request(host: string, state: EnvironmentSetupNetworkRequest['state']) {
  return {
    host,
    reason: `${host} is needed for installs`,
    evidence: { childSessionId: 'child', deniedCount: 2 },
    state,
    requestedAt: '2026-11-04T00:00:00.000Z',
  } satisfies EnvironmentSetupNetworkRequest;
}

describe('pendingNetworkRequests', () => {
  it('keeps only requests that are still waiting for a decision', () => {
    const requests = [
      request('pending.example.com', 'pending'),
      request('approved.example.com', 'approved'),
      request('declined.example.com', 'declined'),
    ];

    expect(pendingNetworkRequests(requests).map(item => item.host)).toEqual([
      'pending.example.com',
    ]);
  });
});

describe('networkDecisionLists', () => {
  it('splits decided hosts and ignores undecided ones', () => {
    expect(
      networkDecisionLists({ 'a.example.com': 'approve', 'b.example.com': 'decline' }, [
        'a.example.com',
        'b.example.com',
        'c.example.com',
      ])
    ).toEqual({ approved: ['a.example.com'], declined: ['b.example.com'] });
  });
});

describe('allHostsDecided', () => {
  it('requires a decision for every pending host', () => {
    expect(allHostsDecided({ 'a.example.com': 'approve' }, ['a.example.com'])).toBe(true);
    expect(
      allHostsDecided({ 'a.example.com': 'approve' }, ['a.example.com', 'b.example.com'])
    ).toBe(false);
  });

  it('keeps saving disabled until every host is decided, then sends only decisions', () => {
    const hosts = ['a.example.com', 'b.example.com'];
    const partial = { 'a.example.com': 'approve' as const };
    expect(allHostsDecided(partial, hosts)).toBe(false);

    const full = { 'a.example.com': 'approve' as const, 'b.example.com': 'decline' as const };
    expect(allHostsDecided(full, hosts)).toBe(true);
    expect(networkDecisionLists(full, hosts)).toEqual({
      approved: ['a.example.com'],
      declined: ['b.example.com'],
    });
  });
});

describe('childKiloSessionIdFor', () => {
  const run: Pick<SetupRunResponse, 'lastVerification' | 'pendingVerification'> = {
    pendingVerification: {
      operationKey: 'verify-1',
      childSessionId: 'pending-child',
      childKiloSessionId: 'kilo-pending',
      configurationRevision: 2,
      checks: [],
      testedHeadSha: null,
      startedAt: '2026-11-04T00:00:00.000Z',
    },
    lastVerification: {
      childSessionId: 'last-child',
      childKiloSessionId: 'kilo-last',
      configurationRevision: 1,
      preparation: 'completed',
      preparationError: null,
      setupDurationMs: 1000,
      egressMode: 'allowlist',
      checks: [],
      results: [],
      testedHeadSha: null,
      recordedAt: '2026-11-04T00:00:00.000Z',
    },
  };

  it('links the evidence of the pending verification', () => {
    expect(childKiloSessionIdFor(run, 'pending-child')).toBe('kilo-pending');
  });

  it('links the evidence of the last verification', () => {
    expect(childKiloSessionIdFor(run, 'last-child')).toBe('kilo-last');
  });

  it('returns null for an unknown child session', () => {
    expect(childKiloSessionIdFor(run, 'other-child')).toBeNull();
  });
});

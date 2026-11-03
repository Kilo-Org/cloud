import { describe, expect, it } from 'vitest';

import * as sessionsLive from '@/lib/active-sessions-live';
import { makeCached } from '@/lib/active-sessions-live-sync.test-helpers';

describe('merge enrichment - associatedPr preservation', () => {
  const associatedPr = {
    url: 'https://github.com/org/repo/pull/42',
    number: 42,
    state: 'open',
    title: 'Fix deploy',
    headSha: null,
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    reviewDecision: null,
    reviewDecisionPending: false,
    platform: 'github',
    observations: { checks: { total: 3, failed: 1 }, unresolvedThreads: 2, truncated: false },
  };

  it('keeps the associated PR and observations through heartbeat and snapshot merges', () => {
    const current = [makeCached({ id: 'a', createdOnPlatform: 'cli', associatedPr })];
    const afterHeartbeat = sessionsLive.mergeHeartbeatForActiveSessions(current, {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'A' }],
    });
    const afterSnapshot = sessionsLive.mergeSnapshotForActiveSessions(current, [
      { id: 'a', status: 'running', title: 'A', connectionId: 'c1' },
    ]);
    expect(afterHeartbeat[0]?.associatedPr).toEqual(associatedPr);
    expect(afterSnapshot[0]?.associatedPr).toEqual(associatedPr);
  });
});

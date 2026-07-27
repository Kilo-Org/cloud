import { describe, expect, it } from 'vitest';

import {
  applySessionStatusUpdated,
  type CachedActiveSession,
  effectiveStatus,
  isAttentionStatus,
  mergeHeartbeatForActiveSessions,
  mergeSnapshotForActiveSessions,
} from '@/lib/active-sessions-live';

function makeCached(over: Partial<CachedActiveSession> = {}): CachedActiveSession {
  return {
    id: 'a1',
    status: 'running',
    title: 'test',
    connectionId: 'c1',
    ...over,
  };
}

describe('isAttentionStatus / effectiveStatus', () => {
  it('treats question and permission as attention', () => {
    expect(isAttentionStatus('question')).toBe(true);
    expect(isAttentionStatus('permission')).toBe(true);
    expect(isAttentionStatus('busy')).toBe(false);
    expect(isAttentionStatus('idle')).toBe(false);
    expect(isAttentionStatus(null)).toBe(false);
  });

  it('prefers stored attention over live idle/busy', () => {
    expect(effectiveStatus('busy', 'question')).toBe('question');
    expect(effectiveStatus('idle', 'permission')).toBe('permission');
  });

  it('yields to live when stored is not attention', () => {
    expect(effectiveStatus('busy', 'idle')).toBe('busy');
    expect(effectiveStatus('idle', null)).toBe('idle');
    expect(effectiveStatus('busy', undefined)).toBe('busy');
  });
});

describe('sticky attention on snapshot / heartbeat merge', () => {
  it('does not clear held attention when the snapshot reports busy', () => {
    const current = [makeCached({ id: 'a', status: 'question', connectionId: 'c1' })];
    const snapshot = [{ id: 'a', status: 'busy', title: 'A', connectionId: 'c1' }];
    expect(mergeSnapshotForActiveSessions(current, snapshot)[0]?.status).toBe('question');
  });

  it('does not clear held permission when the snapshot reports idle', () => {
    const current = [makeCached({ id: 'a', status: 'permission', connectionId: 'c1' })];
    const snapshot = [{ id: 'a', status: 'idle', title: 'A', connectionId: 'c1' }];
    expect(mergeSnapshotForActiveSessions(current, snapshot)[0]?.status).toBe('permission');
  });

  it('takes the snapshot status when the cache is not in attention', () => {
    const current = [makeCached({ id: 'a', status: 'idle', connectionId: 'c1' })];
    const snapshot = [{ id: 'a', status: 'busy', title: 'A', connectionId: 'c1' }];
    expect(mergeSnapshotForActiveSessions(current, snapshot)[0]?.status).toBe('busy');
  });

  it('keeps held attention across repeated non-attention heartbeats (no flicker)', () => {
    const current = [makeCached({ id: 'a', status: 'question', connectionId: 'c1', title: 'A' })];
    let next = current;
    for (const heartbeatStatus of ['busy', 'idle', 'busy'] as const) {
      next = mergeHeartbeatForActiveSessions(next, {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: heartbeatStatus, title: 'A' }],
      });
      expect(next[0]?.status).toBe('question');
    }
  });

  it('does not overwrite non-attention rows with sticky logic', () => {
    const current = [makeCached({ id: 'a', status: 'idle', connectionId: 'c1' })];
    const result = mergeHeartbeatForActiveSessions(current, {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'busy', title: 'A' }],
    });
    expect(result[0]?.status).toBe('busy');
  });
});

describe('applySessionStatusUpdated', () => {
  it('applies a transition out of attention', () => {
    const current = [makeCached({ id: 'a', status: 'question' })];
    expect(applySessionStatusUpdated(current, 'a', 'idle')[0]?.status).toBe('idle');
  });

  it('applies a transition into attention', () => {
    const current = [makeCached({ id: 'a', status: 'busy' })];
    expect(applySessionStatusUpdated(current, 'a', 'permission')[0]?.status).toBe('permission');
  });

  it('ignores unknown session ids', () => {
    const current = [makeCached({ id: 'a', status: 'question' })];
    const result = applySessionStatusUpdated(current, 'other', 'idle');
    expect(result).toEqual(current);
    expect(result[0]?.status).toBe('question');
  });

  it('accepts an empty status string to clear attention', () => {
    const current = [makeCached({ id: 'a', status: 'question' })];
    expect(applySessionStatusUpdated(current, 'a', '')[0]?.status).toBe('');
  });
});

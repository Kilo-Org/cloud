import { describe, expect, it } from 'vitest';

import {
  type CachedActiveSession,
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

describe('mergeSnapshotForActiveSessions capabilities', () => {
  it('takes capabilities from the wire when present', () => {
    const current = [makeCached({ id: 'a', capabilities: { attachments: false } })];
    const snapshot = [
      {
        id: 'a',
        status: 'running',
        title: 'A',
        connectionId: 'c1',
        capabilities: { attachments: true },
      },
    ];
    const result = mergeSnapshotForActiveSessions(current, snapshot);
    expect(result[0]?.capabilities).toEqual({ attachments: true });
  });

  it('preserves cached capabilities when the wire row lacks the field', () => {
    const current = [makeCached({ id: 'a', capabilities: { attachments: true } })];
    const snapshot = [{ id: 'a', status: 'running', title: 'A', connectionId: 'c1' }];
    const result = mergeSnapshotForActiveSessions(current, snapshot);
    expect(result[0]?.capabilities).toEqual({ attachments: true });
  });

  it('replaces capabilities when the wire value changes (true→false)', () => {
    const current = [makeCached({ id: 'a', capabilities: { attachments: true } })];
    const snapshot = [
      {
        id: 'a',
        status: 'running',
        title: 'A',
        connectionId: 'c1',
        capabilities: { attachments: false },
      },
    ];
    const result = mergeSnapshotForActiveSessions(current, snapshot);
    expect(result[0]?.capabilities).toEqual({ attachments: false });
  });
});

describe('mergeHeartbeatForActiveSessions capabilities', () => {
  it('takes capabilities from the wire when present', () => {
    const current = [
      makeCached({ id: 'a', connectionId: 'c1', capabilities: { attachments: false } }),
    ];
    const payload = {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'A2', capabilities: { attachments: true } }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result[0]?.capabilities).toEqual({ attachments: true });
  });

  it('preserves cached capabilities when the wire row lacks the field', () => {
    const current = [
      makeCached({ id: 'a', connectionId: 'c1', capabilities: { attachments: true } }),
    ];
    const payload = {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'A2' }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result[0]?.capabilities).toEqual({ attachments: true });
  });

  it('replaces capabilities when the wire value changes (true→false)', () => {
    const current = [
      makeCached({ id: 'a', connectionId: 'c1', capabilities: { attachments: true } }),
    ];
    const payload = {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'A2', capabilities: { attachments: false } }],
    };
    const result = mergeHeartbeatForActiveSessions(current, payload);
    expect(result[0]?.capabilities).toEqual({ attachments: false });
  });
});

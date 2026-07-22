import { describe, expect, it } from 'vitest';

import {
  parseCliConnectionPayload,
  parseHeartbeatPayload,
  parseSessionsListPayload,
  selectRootWsSessions,
} from '@/lib/active-sessions-live';

// ── Root filter ──────────────────────────────────────────────────────

describe('selectRootWsSessions', () => {
  it('drops rows with a parentSessionId', () => {
    const rows = [
      { id: 'root1', status: 'running', title: 'r1', connectionId: 'c1' },
      {
        id: 'child1',
        status: 'running',
        title: 'c1',
        connectionId: 'c1',
        parentSessionId: 'root1',
      },
      { id: 'root2', status: 'running', title: 'r2', connectionId: 'c1' },
    ];
    expect(selectRootWsSessions(rows).map(r => r.id)).toEqual(['root1', 'root2']);
  });
});

// ── Payload parsing ──────────────────────────────────────────────────

describe('parseHeartbeatPayload', () => {
  it('parses a valid heartbeat', () => {
    expect(
      parseHeartbeatPayload({
        connectionId: 'c1',
        sessions: [{ id: 's1', status: 'running', title: 't' }],
      })
    ).toEqual({
      connectionId: 'c1',
      sessions: [{ id: 's1', status: 'running', title: 't' }],
    });
  });

  it('strips the extra protocolVersion field (default Zod behavior on the parent)', () => {
    // The SDK schema only requires connectionId+sessions; extra fields
    // are accepted and dropped, so this should still parse to the same
    // shape.
    const parsed = parseHeartbeatPayload({
      connectionId: 'c1',
      protocolVersion: 2,
      sessions: [{ id: 's1', status: 'running', title: 't' }],
    });
    expect(parsed).toEqual({
      connectionId: 'c1',
      sessions: [{ id: 's1', status: 'running', title: 't' }],
    });
  });

  it('rejects when connectionId is missing', () => {
    expect(parseHeartbeatPayload({ sessions: [] })).toBeNull();
  });

  it('rejects when sessions is not an array', () => {
    expect(parseHeartbeatPayload({ connectionId: 'c1', sessions: 'nope' })).toBeNull();
  });
});

describe('parseSessionsListPayload', () => {
  it('parses a valid sessions list', () => {
    expect(
      parseSessionsListPayload({
        sessions: [{ id: 's1', status: 'running', title: 't', connectionId: 'c1' }],
      })
    ).toEqual([{ id: 's1', status: 'running', title: 't', connectionId: 'c1' }]);
  });

  it('rejects when connectionId is missing on a row', () => {
    expect(
      parseSessionsListPayload({
        sessions: [{ id: 's1', status: 'running', title: 't' }],
      })
    ).toBeNull();
  });
});

describe('parseCliConnectionPayload', () => {
  it('parses a cli connection payload', () => {
    expect(parseCliConnectionPayload({ connectionId: 'c1' })).toEqual({ connectionId: 'c1' });
  });
  it('rejects unknown shape', () => {
    expect(parseCliConnectionPayload({})).toBeNull();
  });
});

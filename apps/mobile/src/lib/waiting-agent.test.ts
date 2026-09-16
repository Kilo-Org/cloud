import { beforeEach, describe, expect, it } from 'vitest';

import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { __resetSessionAttentionForTests, ackSessionAttention } from '@/lib/session-attention';
import { pickWaitingAgent } from '@/lib/waiting-agent';

function session(over: Partial<ActiveSession> & Pick<ActiveSession, 'id'>): ActiveSession {
  return {
    status: 'question',
    title: 'test',
    connectionId: 'c1',
    ...over,
  };
}

describe('pickWaitingAgent', () => {
  beforeEach(() => {
    __resetSessionAttentionForTests();
  });

  it('returns null when there are no sessions', () => {
    expect(pickWaitingAgent([])).toBeNull();
  });

  it('returns the only waiting row', () => {
    const only = session({ id: 'a' });
    expect(pickWaitingAgent([only])).toBe(only);
  });

  it('returns the first waiting row in canonical order (newest enriched row)', () => {
    const older = session({ id: 'older', createdAt: '2026-07-01T10:00:00.000Z' });
    const newer = session({ id: 'newer', createdAt: '2026-07-02T10:00:00.000Z' });
    // Canonical order is `sortActiveSessionsByCreatedAt`: unenriched first, then
    // enriched newest-first. Both are enriched, so the newer row leads.
    expect(pickWaitingAgent([older, newer])?.id).toBe('newer');
    expect(pickWaitingAgent([newer, older])?.id).toBe('newer');
  });

  it('breaks a createdAt tie by id ascending, like the canonical comparator', () => {
    const b = session({ id: 'b', createdAt: '2026-07-01T10:00:00.000Z' });
    const a = session({ id: 'a', createdAt: '2026-07-01T10:00:00.000Z' });
    expect(pickWaitingAgent([b, a])?.id).toBe('a');
  });

  it('returns the unenriched row first, like the canonical comparator', () => {
    const unenriched = session({ id: 'z' });
    const enriched = session({ id: 'a', createdAt: '2026-07-02T10:00:00.000Z' });
    expect(pickWaitingAgent([enriched, unenriched])?.id).toBe('z');
  });

  it('returns null when the only waiting row is acked', () => {
    const acked = session({ id: 'acked' });
    ackSessionAttention(acked.id);
    expect(pickWaitingAgent([acked])).toBeNull();
  });

  it('skips an acked raise and opens the unacked one', () => {
    const acked = session({ id: 'acked', createdAt: '2026-07-02T10:00:00.000Z' });
    const unacked = session({ id: 'unacked', createdAt: '2026-07-01T10:00:00.000Z' });
    ackSessionAttention(acked.id);
    expect(pickWaitingAgent([acked, unacked])?.id).toBe('unacked');
  });

  it('returns null for busy, idle, and retry rows — the empty-state data condition', () => {
    const rows = [
      session({ id: 'busy', status: 'busy' }),
      session({ id: 'idle', status: 'idle' }),
      session({ id: 'retry', status: 'retry' }),
    ];
    expect(pickWaitingAgent(rows)).toBeNull();
  });

  it('treats a permission raise like a question raise', () => {
    const permission = session({ id: 'permission', status: 'permission' });
    expect(pickWaitingAgent([permission])).toBe(permission);
  });

  it('does not mutate the input array', () => {
    const older = session({ id: 'older', createdAt: '2026-07-01T10:00:00.000Z' });
    const newer = session({ id: 'newer', createdAt: '2026-07-02T10:00:00.000Z' });
    const input = [older, newer];
    pickWaitingAgent(input);
    expect(input).toEqual([older, newer]);
  });
});

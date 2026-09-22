import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_EVENT_REPLAY_BYTES,
  MAX_SESSION_EVENT_REPLAY_EVENTS,
  SESSION_EVENT_REPLAY_TTL_MS,
  createSessionEventReplayQueue,
} from './session-event-replay.js';

const NOW = 1_700_000_000_000;
const TTL = SESSION_EVENT_REPLAY_TTL_MS;

function push(
  queue: ReturnType<typeof createSessionEventReplayQueue<string>>,
  sessionId: string,
  value: string,
  bytes = 16,
  expiresAt = NOW + TTL
) {
  return queue.push({ sessionId, bytes, expiresAt, value });
}

describe('createSessionEventReplayQueue', () => {
  it('keeps per-session FIFO order and isolates sessions from each other', () => {
    const queue = createSessionEventReplayQueue<string>();
    expect(push(queue, 'workspace_a', 'a1')).toBe('queued');
    expect(push(queue, 'workspace_a', 'a2')).toBe('queued');
    expect(push(queue, 'workspace_b', 'b1')).toBe('queued');

    expect(queue.shift('workspace_a', NOW)).toEqual({
      value: 'a1',
      bytes: 16,
      expiresAt: NOW + TTL,
    });
    expect(queue.shift('workspace_a', NOW)).toEqual({
      value: 'a2',
      bytes: 16,
      expiresAt: NOW + TTL,
    });
    expect(queue.shift('workspace_a', NOW)).toBeUndefined();
    expect(queue.shift('workspace_b', NOW)).toEqual({
      value: 'b1',
      bytes: 16,
      expiresAt: NOW + TTL,
    });
    expect(queue.sessions()).toEqual([]);
  });

  it('rejects the newest entry at the event cap and preserves the retained prefix', () => {
    const queue = createSessionEventReplayQueue<number>();
    for (let index = 0; index < MAX_SESSION_EVENT_REPLAY_EVENTS; index++) {
      expect(
        queue.push({ sessionId: 'workspace_a', bytes: 1, expiresAt: NOW + TTL, value: index })
      ).toBe('queued');
    }

    expect(
      queue.push({ sessionId: 'workspace_a', bytes: 1, expiresAt: NOW + TTL, value: -1 })
    ).toBe('overflow');
    expect(queue.stats()).toEqual({
      events: MAX_SESSION_EVENT_REPLAY_EVENTS,
      bytes: MAX_SESSION_EVENT_REPLAY_EVENTS,
      sessions: 1,
    });

    const shifted: number[] = [];
    for (
      let entry = queue.shift('workspace_a', NOW);
      entry;
      entry = queue.shift('workspace_a', NOW)
    ) {
      shifted.push(entry.value);
    }
    expect(shifted).toHaveLength(MAX_SESSION_EVENT_REPLAY_EVENTS);
    expect(shifted[0]).toBe(0);
    expect(shifted.at(-1)).toBe(MAX_SESSION_EVENT_REPLAY_EVENTS - 1);
    expect(queue.stats()).toEqual({ events: 0, bytes: 0, sessions: 0 });
  });

  it('rejects an entry that would exceed the byte cap', () => {
    const queue = createSessionEventReplayQueue<string>();
    expect(
      queue.push({
        sessionId: 'workspace_a',
        bytes: MAX_SESSION_EVENT_REPLAY_BYTES,
        expiresAt: NOW + TTL,
        value: 'large',
      })
    ).toBe('queued');
    expect(
      queue.push({ sessionId: 'workspace_a', bytes: 1, expiresAt: NOW + TTL, value: 'extra' })
    ).toBe('overflow');
    expect(queue.stats()).toEqual({
      events: 1,
      bytes: MAX_SESSION_EVENT_REPLAY_BYTES,
      sessions: 1,
    });
    expect(queue.shift('workspace_a', NOW)).toEqual({
      value: 'large',
      bytes: MAX_SESSION_EVENT_REPLAY_BYTES,
      expiresAt: NOW + TTL,
    });
    expect(queue.stats()).toEqual({ events: 0, bytes: 0, sessions: 0 });
  });

  it('expires entries at their TTL and reports them once', () => {
    const queue = createSessionEventReplayQueue<string>();
    push(queue, 'workspace_a', 'fresh', 16, NOW + 1_000);
    push(queue, 'workspace_b', 'stale', 16, NOW + 500);

    expect(queue.expire(NOW + 500)).toEqual(['stale']);
    expect(queue.expire(NOW + 500)).toEqual([]);
    expect(queue.sessions()).toEqual(['workspace_a']);
    expect(queue.expire(NOW + 1_000)).toEqual(['fresh']);
    expect(queue.stats()).toEqual({ events: 0, bytes: 0, sessions: 0 });
  });

  it('returns the head with its bytes and expiry so the caller can decide', () => {
    const queue = createSessionEventReplayQueue<string>();
    push(queue, 'workspace_a', 'stale', 16, NOW + 100);
    push(queue, 'workspace_a', 'fresh', 8, NOW + 10_000);

    expect(queue.shift('workspace_a', NOW + 200)).toEqual({
      value: 'stale',
      bytes: 16,
      expiresAt: NOW + 100,
    });
    expect(queue.shift('workspace_a', NOW + 200)).toEqual({
      value: 'fresh',
      bytes: 8,
      expiresAt: NOW + 10_000,
    });
    expect(queue.stats()).toEqual({ events: 0, bytes: 0, sessions: 0 });
  });

  it('deletes a session once its last entry is shifted', () => {
    const queue = createSessionEventReplayQueue<string>();
    push(queue, 'workspace_a', 'a1');
    expect(queue.shift('workspace_a', NOW)).toEqual({
      value: 'a1',
      bytes: 16,
      expiresAt: NOW + TTL,
    });
    expect(queue.shift('workspace_a', NOW)).toBeUndefined();
    expect(queue.sessions()).toEqual([]);
    expect(queue.stats()).toEqual({ events: 0, bytes: 0, sessions: 0 });
  });

  it('restores an unapplied entry to the front of its session queue', () => {
    const queue = createSessionEventReplayQueue<string>();
    push(queue, 'workspace_a', 'a1', 16, NOW + TTL);
    push(queue, 'workspace_a', 'a2', 8, NOW + TTL);

    const first = queue.shift('workspace_a', NOW);
    expect(queue.restore('workspace_a', first!)).toBe('queued');
    expect(queue.stats()).toEqual({ events: 2, bytes: 24, sessions: 1 });

    expect(queue.shift('workspace_a', NOW)?.value).toBe('a1');
    expect(queue.shift('workspace_a', NOW)?.value).toBe('a2');
    expect(queue.stats()).toEqual({ events: 0, bytes: 0, sessions: 0 });
  });

  it('keeps the original expiry of a restored entry', () => {
    const queue = createSessionEventReplayQueue<string>();
    push(queue, 'workspace_a', 'a1', 16, NOW + 500);

    const first = queue.shift('workspace_a', NOW);
    expect(first).toEqual({ value: 'a1', bytes: 16, expiresAt: NOW + 500 });
    expect(queue.restore('workspace_a', first!)).toBe('queued');
    expect(queue.expire(NOW + 500)).toEqual(['a1']);
    expect(queue.stats()).toEqual({ events: 0, bytes: 0, sessions: 0 });
  });

  it('rejects a restore that would exceed the byte cap', () => {
    const queue = createSessionEventReplayQueue<string>();
    push(queue, 'workspace_a', 'large', MAX_SESSION_EVENT_REPLAY_BYTES, NOW + TTL);
    const head = queue.shift('workspace_a', NOW);
    expect(head).toEqual({
      value: 'large',
      bytes: MAX_SESSION_EVENT_REPLAY_BYTES,
      expiresAt: NOW + TTL,
    });
    push(queue, 'workspace_a', 'other', 1, NOW + TTL);
    expect(queue.restore('workspace_a', head!)).toBe('overflow');
    expect(queue.stats()).toEqual({ events: 1, bytes: 1, sessions: 1 });
  });
});

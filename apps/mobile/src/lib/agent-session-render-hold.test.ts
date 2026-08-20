import { describe, expect, it } from 'vitest';

import {
  resolveStoredSessionsHold,
  type StoredSessionsHold,
} from '@/lib/agent-session-render-hold';

type Session = { session_id: string; title: string };

const session = (id: string): Session => ({ session_id: id, title: id });

describe('resolveStoredSessionsHold', () => {
  it('renders non-empty current and captures a hold keyed to the query key', () => {
    const current = [session('a'), session('b')];

    const result = resolveStoredSessionsHold({
      current,
      isFetching: false,
      queryKeyJson: 'key-1',
      previousHold: null,
    });

    expect(result.sessions).toBe(current);
    expect(result.hold).toEqual({ key: 'key-1', sessions: current });
  });

  it('renders held rows and keeps the hold when empty + fetching + same key', () => {
    const held = [session('a'), session('b')];
    const previousHold: StoredSessionsHold<Session> = { key: 'key-1', sessions: held };

    const result = resolveStoredSessionsHold({
      current: [],
      isFetching: true,
      queryKeyJson: 'key-1',
      previousHold,
    });

    expect(result.sessions).toBe(held);
    expect(result.hold).toBe(previousHold);
  });

  it('renders empty and clears the hold when empty + fetching + different key', () => {
    const previousHold: StoredSessionsHold<Session> = {
      key: 'key-1',
      sessions: [session('a')],
    };

    const result = resolveStoredSessionsHold({
      current: [],
      isFetching: true,
      queryKeyJson: 'key-2',
      previousHold,
    });

    expect(result.sessions).toEqual([]);
    expect(result.hold).toBeNull();
  });

  it('renders empty and keeps hold null on a cold load (empty + fetching + no hold)', () => {
    const result = resolveStoredSessionsHold({
      current: [],
      isFetching: true,
      queryKeyJson: 'key-1',
      previousHold: null,
    });

    expect(result.sessions).toEqual([]);
    expect(result.hold).toBeNull();
  });

  it('renders empty and clears the hold on a settled empty (empty + not fetching + hold set)', () => {
    const previousHold: StoredSessionsHold<Session> = {
      key: 'key-1',
      sessions: [session('a')],
    };

    const result = resolveStoredSessionsHold({
      current: [],
      isFetching: false,
      queryKeyJson: 'key-1',
      previousHold,
    });

    expect(result.sessions).toEqual([]);
    expect(result.hold).toBeNull();
  });

  it('recovers: held rows render, then fresh non-empty data updates the hold', () => {
    const held = [session('a')];
    const previousHold: StoredSessionsHold<Session> = { key: 'key-1', sessions: held };

    const heldRender = resolveStoredSessionsHold({
      current: [],
      isFetching: true,
      queryKeyJson: 'key-1',
      previousHold,
    });
    expect(heldRender.sessions).toBe(held);

    const fresh = [session('a'), session('b')];
    const recovered = resolveStoredSessionsHold({
      current: fresh,
      isFetching: true,
      queryKeyJson: 'key-1',
      previousHold: heldRender.hold,
    });

    expect(recovered.sessions).toBe(fresh);
    expect(recovered.hold).toEqual({ key: 'key-1', sessions: fresh });
  });

  it('keeps the same held array across two consecutive blank renders', () => {
    const held = [session('a')];
    const previousHold: StoredSessionsHold<Session> = { key: 'key-1', sessions: held };

    const first = resolveStoredSessionsHold({
      current: [],
      isFetching: true,
      queryKeyJson: 'key-1',
      previousHold,
    });
    const second = resolveStoredSessionsHold({
      current: [],
      isFetching: true,
      queryKeyJson: 'key-1',
      previousHold: first.hold,
    });

    expect(first.sessions).toBe(held);
    expect(second.sessions).toBe(held);
    expect(second.hold).toBe(previousHold);
  });
});

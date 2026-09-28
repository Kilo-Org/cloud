import { describe, expect, it } from 'vitest';

import {
  LIVE_SESSIONS_EMPTY_HOLD_MS,
  type LiveSessionsHold,
  resolveLiveSessionsHold,
} from '@/lib/live-sessions-render-hold';

type Session = { id: string };

const session = (id: string): Session => ({ id });

const held = (rows: Session[], over: Partial<LiveSessionsHold<Session>> = {}) => ({
  key: 'key-1',
  sessions: rows,
  emptySince: null,
  ...over,
});

function resolve(over: {
  current: Session[];
  scopeKey?: string;
  canHold?: boolean;
  now?: number;
  previousHold?: LiveSessionsHold<Session> | null;
}) {
  return resolveLiveSessionsHold({
    scopeKey: 'key-1',
    canHold: true,
    now: 1000,
    previousHold: null,
    ...over,
  });
}

describe('resolveLiveSessionsHold', () => {
  it('renders the live rows and captures a hold keyed to the query', () => {
    const current = [session('a'), session('b')];

    const result = resolve({ current });

    expect(result.sessions).toBe(current);
    expect(result.hold).toEqual({ key: 'key-1', sessions: current, emptySince: null });
    expect(result.releaseDelayMs).toBeNull();
  });

  it('keeps rendering the last rows while the socket-emptied set is inside the window', () => {
    const rows = [session('a')];
    const previousHold = held(rows, { emptySince: 1000 });

    const result = resolve({ current: [], previousHold, now: 1000 + 4999 });

    expect(result.sessions).toBe(rows);
    expect(result.hold).toEqual({ key: 'key-1', sessions: rows, emptySince: 1000 });
    expect(result.releaseDelayMs).toBe(1);
  });

  it('starts the window on the first empty render and shortens the delay as it runs', () => {
    const rows = [session('a')];

    const start = resolve({ current: [], previousHold: held(rows), now: 5000 });
    expect(start.sessions).toBe(rows);
    expect(start.releaseDelayMs).toBe(LIVE_SESSIONS_EMPTY_HOLD_MS);

    const later = resolve({ current: [], previousHold: start.hold, now: 7500 });
    expect(later.sessions).toBe(rows);
    expect(later.hold?.emptySince).toBe(5000);
    expect(later.releaseDelayMs).toBe(2500);
  });

  it('releases to the empty set once the window expires', () => {
    const rows = [session('a')];
    const previousHold = held(rows, { emptySince: 1000 });

    const result = resolve({
      current: [],
      previousHold,
      now: 1000 + LIVE_SESSIONS_EMPTY_HOLD_MS,
    });

    expect(result.sessions).toEqual([]);
    expect(result.hold).toBeNull();
    expect(result.releaseDelayMs).toBeNull();
  });

  it('does not stretch the window when the clock steps backwards', () => {
    const rows = [session('a')];
    const previousHold = held(rows, { emptySince: 1000 });

    const steppedBack = resolve({ current: [], previousHold, now: 1000 - 60_000 });

    expect(steppedBack.sessions).toBe(rows);
    expect(steppedBack.releaseDelayMs).toBe(LIVE_SESSIONS_EMPTY_HOLD_MS);
    expect(steppedBack.hold?.emptySince).toBe(1000 - 60_000);
  });

  it('retires the hold immediately when the rows come back inside the window', () => {
    const rows = [session('a')];
    const reconnected = [session('a'), session('b')];

    const result = resolve({
      current: reconnected,
      previousHold: held(rows, { emptySince: 1000 }),
      now: 1500,
    });

    expect(result.sessions).toBe(reconnected);
    expect(result.hold).toEqual({ key: 'key-1', sessions: reconnected, emptySince: null });
    expect(result.releaseDelayMs).toBeNull();
  });

  it('never holds across a context change', () => {
    const result = resolve({
      current: [],
      scopeKey: 'key-2',
      previousHold: held([session('a')]),
    });

    expect(result.sessions).toEqual([]);
    expect(result.hold).toBeNull();
  });

  it('never holds when the caller may not read', () => {
    const result = resolve({ current: [], canHold: false, previousHold: held([session('a')]) });

    expect(result.sessions).toEqual([]);
    expect(result.hold).toBeNull();
  });

  it('does not hold an empty set that was never populated', () => {
    const result = resolve({ current: [] });

    expect(result.sessions).toEqual([]);
    expect(result.hold).toBeNull();
  });

  it('keeps the same held array across consecutive empty renders', () => {
    const rows = [session('a')];
    const previousHold = held(rows, { emptySince: 1000 });

    const first = resolve({ current: [], previousHold, now: 2000 });
    const second = resolve({ current: [], previousHold: first.hold, now: 3000 });

    expect(first.sessions).toBe(rows);
    expect(second.sessions).toBe(rows);
  });
});

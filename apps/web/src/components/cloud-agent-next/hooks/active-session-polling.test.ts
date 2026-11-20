import { getActiveSessionsRefetchInterval } from './useActiveSessions';

it('does not poll idle or completed sessions', () => {
  expect(getActiveSessionsRefetchInterval([{ status: 'idle' }, { status: 'completed' }])).toBe(
    false
  );
});

it('polls running sessions until their status becomes stale at three hours', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  expect(
    getActiveSessionsRefetchInterval([{ status: 'busy', updatedAt: '2026-11-16T11:00:00Z' }], now)
  ).toBe(10_000);
  expect(
    getActiveSessionsRefetchInterval([{ status: 'retry', updatedAt: '2026-11-16T09:00:00Z' }], now)
  ).toBe(false);
});

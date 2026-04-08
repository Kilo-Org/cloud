import { describe, expect, it } from '@jest/globals';
import { shouldPersistCliRunControllerStatus } from '@/lib/kiloclaw/cli-runs';

describe('shouldPersistCliRunControllerStatus', () => {
  it('returns true when the controller run matches the stored row timestamp', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: '2026-04-08T12:00:00.000Z' },
        {
          hasRun: true,
          status: 'completed',
          startedAt: '2026-04-08T12:00:00Z',
        }
      )
    ).toBe(true);
  });

  it('returns false when the controller status is still running', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: '2026-04-08T12:00:00.000Z' },
        {
          hasRun: true,
          status: 'running',
          startedAt: '2026-04-08T12:00:00Z',
        }
      )
    ).toBe(false);
  });

  it('returns false when the controller timestamp belongs to a different run', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: '2026-04-08T12:00:00.000Z' },
        {
          hasRun: true,
          status: 'failed',
          startedAt: '2026-04-08T12:05:00Z',
        }
      )
    ).toBe(false);
  });

  it('returns false when the stored row timestamp is missing', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: null },
        {
          hasRun: true,
          status: 'completed',
          startedAt: '2026-04-08T12:00:00Z',
        }
      )
    ).toBe(false);
  });

  it('returns false when the controller timestamp is missing', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: '2026-04-08T12:00:00.000Z' },
        {
          hasRun: true,
          status: 'completed',
          startedAt: null,
        }
      )
    ).toBe(false);
  });

  it('returns false when there is no controller run', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: '2026-04-08T12:00:00.000Z' },
        {
          hasRun: false,
          status: 'completed',
          startedAt: '2026-04-08T12:00:00Z',
        }
      )
    ).toBe(false);
  });
});

import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  getSafetyIdentifierStatus,
  regenerateSafetyIdentifiers,
  SAFETY_IDENTIFIER_BACKFILL_ERROR,
} from '@/lib/safety-identifiers';
import { GET, POST, maxDuration } from './route';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/safety-identifiers', () => ({
  getSafetyIdentifierStatus: jest.fn(),
  regenerateSafetyIdentifiers: jest.fn(),
  SAFETY_IDENTIFIER_BACKFILL_ERROR: 'Safety identifier regeneration failed. Retry to resume.',
  SAFETY_IDENTIFIER_WORK_BUDGET_MS: 240_000,
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getUserFromAuth).mockResolvedValue({
    user: defineTestUser({ is_admin: true }),
    authFailedResponse: null,
  });
});

test.each([GET, POST])(
  'requires existing admin authorization before accessing progress or mutating users',
  async handler => {
    const denied = NextResponse.json(
      { success: false as const, error: 'Unauthorized' },
      { status: 403 }
    );
    jest.mocked(getUserFromAuth).mockResolvedValue({ user: null, authFailedResponse: denied });
    expect(await handler()).toBe(denied);
    expect(getUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
    expect(getSafetyIdentifierStatus).not.toHaveBeenCalled();
    expect(regenerateSafetyIdentifiers).not.toHaveBeenCalled();
  }
);

test('returns resumable progress without mutating', async () => {
  const status = {
    running: false,
    batchSize: 5000,
    scheduleMinutes: 3,
    backfill: {
      status: 'pending' as const,
      processed: 0,
      total: null,
      cursor: null,
      startedAt: null,
      updatedAt: null,
      completedAt: null,
      lastBatchProcessed: 0,
      lastError: null,
    },
  };
  jest.mocked(getSafetyIdentifierStatus).mockResolvedValue(status);
  await expect((await GET()).json()).resolves.toEqual(status);
  expect(regenerateSafetyIdentifiers).not.toHaveBeenCalled();
});

test('runs the same bounded regeneration pass and retains the POST response shape', async () => {
  const before = Date.now();
  jest
    .mocked(regenerateSafetyIdentifiers)
    .mockResolvedValue({ processed: 5, remaining: true, skipped: false });
  await expect((await POST()).json()).resolves.toEqual({ processed: 5, remaining: true });
  const { deadlineAt } = jest.mocked(regenerateSafetyIdentifiers).mock.calls[0][0];
  expect(deadlineAt).toBeGreaterThanOrEqual(before + 240_000);
  expect(deadlineAt - before).toBeLessThan(maxDuration * 1000);
});

test('returns 409 when cron or another admin owns the mutex', async () => {
  jest
    .mocked(regenerateSafetyIdentifiers)
    .mockResolvedValue({ processed: 0, remaining: true, skipped: true });
  expect((await POST()).status).toBe(409);
});

test.each([GET, POST])('returns only a generic error on backend failures', async handler => {
  jest.mocked(getSafetyIdentifierStatus).mockRejectedValue(new Error('synthetic private input'));
  jest.mocked(regenerateSafetyIdentifiers).mockRejectedValue(new Error('synthetic private input'));
  const response = await handler();
  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toEqual({ error: SAFETY_IDENTIFIER_BACKFILL_ERROR });
});

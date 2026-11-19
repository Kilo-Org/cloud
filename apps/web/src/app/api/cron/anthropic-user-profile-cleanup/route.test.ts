jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/anthropic-user-profiles/cleanup', () => ({
  runAnthropicUserProfileCleanup: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { captureException } from '@sentry/nextjs';
import { runAnthropicUserProfileCleanup } from '@/lib/anthropic-user-profiles/cleanup';
import { GET, maxDuration } from './route';

const mockCleanup = jest.mocked(runAnthropicUserProfileCleanup);
const mockCaptureException = jest.mocked(captureException);

function request(authorization?: string): Request {
  return new Request('http://localhost:3000/api/cron/anthropic-user-profile-cleanup', {
    headers: authorization ? { authorization } : undefined,
  });
}

describe('GET /api/cron/anthropic-user-profile-cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows time for a capped deletion run', () => {
    expect(maxDuration).toBe(300);
  });

  it('rejects unauthorized requests without running the cleanup', async () => {
    const response = await GET(request('Bearer wrong-secret'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it.each([
    ['a skipped run', { skipped: true as const }],
    [
      'a completed run',
      {
        skipped: false as const,
        scanned: 10,
        candidates: 4,
        deletedUnlinked: 2,
        deletedUserBlocked: 1,
        kept: 1,
        failed: 0,
        prunedLogs: 3,
      },
    ],
  ])('returns 200 for %s', async (_description, counts) => {
    mockCleanup.mockResolvedValue(counts);

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, counts });
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  it('captures cleanup failures and returns 500', async () => {
    const error = new Error('Anthropic unavailable');
    mockCleanup.mockRejectedValue(error);

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Failed to clean up Anthropic user profiles',
    });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { endpoint: 'cron/anthropic-user-profile-cleanup' },
    });
  });
});

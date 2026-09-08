jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/user/deletion-queue/deletion-attention-slack-summary', () => ({
  sendUserDeletionAttentionSlackSummary: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { captureException } from '@sentry/nextjs';
import { sendUserDeletionAttentionSlackSummary } from '@/lib/user/deletion-queue/deletion-attention-slack-summary';
import { GET } from './route';

const mockSendSummary = jest.mocked(sendUserDeletionAttentionSlackSummary);
const mockCaptureException = jest.mocked(captureException);

function request(authorization?: string): Request {
  return new Request('http://localhost:3000/api/cron/user-deletion-attention-summary', {
    headers: authorization ? { authorization } : undefined,
  });
}

describe('GET /api/cron/user-deletion-attention-summary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unauthorized requests without reading the summary', async () => {
    const response = await GET(request('Bearer wrong-secret'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockSendSummary).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty current-state summary', { checked: 4, actionable: 0, listed: 0 }],
    ['a configuration-skipped summary', { checked: 4, actionable: 2, listed: 2 }],
  ])('returns 200 for %s', async (_description, counts) => {
    mockSendSummary.mockResolvedValue(counts);

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, counts });
    expect(mockSendSummary).toHaveBeenCalledTimes(1);
  });

  it('captures summary query or delivery failures and returns 500', async () => {
    const error = new Error('Slack unavailable');
    mockSendSummary.mockRejectedValue(error);

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Failed to send user deletion attention summary',
    });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { endpoint: 'cron/user-deletion-attention-summary' },
    });
  });
});

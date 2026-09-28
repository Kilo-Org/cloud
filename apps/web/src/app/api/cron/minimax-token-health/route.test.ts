jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/coding-plans/minimax-token-health', () => ({
  sendMiniMaxTokenHealthSlackSummary: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { captureException } from '@sentry/nextjs';
import { sendMiniMaxTokenHealthSlackSummary } from '@/lib/coding-plans/minimax-token-health';
import { GET } from './route';

const mockSendSummary = jest.mocked(sendMiniMaxTokenHealthSlackSummary);
const mockCaptureException = jest.mocked(captureException);

function request(authorization?: string) {
  return new Request('http://localhost:3000/api/cron/minimax-token-health', {
    headers: authorization ? { authorization } : undefined,
  });
}

describe('GET /api/cron/minimax-token-health', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects invalid cron authorization', async () => {
    const response = await GET(request('Bearer wrong-secret'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockSendSummary).not.toHaveBeenCalled();
  });

  it('sends the current token health summary for valid cron authorization', async () => {
    mockSendSummary.mockResolvedValue({
      checked: 160,
      healthy: 155,
      badResponse: 3,
      denied: 1,
      unreachable: 1,
      configuration: 0,
      needsFollowUp: 4,
    });

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      totals: { checked: 160, healthy: 155, needsFollowUp: 4 },
    });
    expect(mockSendSummary).toHaveBeenCalledTimes(1);
  });

  it('returns a failed cron response when the sweep fails', async () => {
    const error = new Error('Slack unavailable');
    mockSendSummary.mockRejectedValue(error);

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Failed to send MiniMax token health summary',
    });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { endpoint: 'cron/minimax-token-health' },
    });
  });
});

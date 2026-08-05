jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/coding-plans/inventory-slack-summary', () => ({
  sendCodingPlanInventorySlackSummary: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { captureException } from '@sentry/nextjs';
import { sendCodingPlanInventorySlackSummary } from '@/lib/coding-plans/inventory-slack-summary';
import { GET } from './route';

const mockSendSummary = jest.mocked(sendCodingPlanInventorySlackSummary);
const mockCaptureException = jest.mocked(captureException);

function request(authorization?: string) {
  return new Request('http://localhost:3000/api/cron/coding-plans-inventory-summary', {
    headers: authorization ? { authorization } : undefined,
  });
}

describe('GET /api/cron/coding-plans-inventory-summary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects invalid cron authorization', async () => {
    const response = await GET(request('Bearer wrong-secret'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockSendSummary).not.toHaveBeenCalled();
  });

  it('sends the current inventory summary for valid cron authorization', async () => {
    mockSendSummary.mockResolvedValue({
      loaded: 263,
      assigned: 156,
      available: 83,
      waitlist: 13,
      revocationPending: 5,
      revocationFailed: 0,
      revoked: 19,
    });

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      totals: { loaded: 263, available: 83, revocationPending: 5 },
    });
    expect(mockSendSummary).toHaveBeenCalledTimes(1);
  });

  it('returns a failed cron response when Slack delivery fails', async () => {
    const error = new Error('Slack unavailable');
    mockSendSummary.mockRejectedValue(error);

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Failed to send Coding Plans inventory summary',
    });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { endpoint: 'cron/coding-plans-inventory-summary' },
    });
  });
});

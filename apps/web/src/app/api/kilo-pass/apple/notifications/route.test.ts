import { captureException } from '@sentry/nextjs';

import { processAppStoreKiloPassNotification } from '@/lib/kilo-pass/apple-store-notifications';
import { POST } from './route';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/kilo-pass/apple-store-notifications', () => ({
  processAppStoreKiloPassNotification: jest.fn(),
}));

const mockProcess = jest.mocked(processAppStoreKiloPassNotification);

function request(body: unknown) {
  return new Request('https://app.example.com/api/kilo-pass/apple/notifications', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/kilo-pass/apple/notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProcess.mockResolvedValue({ processed: true });
  });

  it('returns 400 when signedPayload is missing', async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing signedPayload' });
  });

  it('processes signed App Store notification payloads', async () => {
    const response = await POST(request({ signedPayload: 'payload' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: true });
    expect(mockProcess).toHaveBeenCalledWith({ signedPayload: 'payload' });
  });

  it('treats already-processed duplicate notifications as idempotent success', async () => {
    mockProcess.mockResolvedValueOnce({ processed: true, status: 'already_processed' });

    const response = await POST(request({ signedPayload: 'payload' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: true, status: 'already_processed' });
  });

  it('asks Apple to retry fresh in-flight duplicate notifications', async () => {
    mockProcess.mockResolvedValueOnce({ processed: false, status: 'in_flight' });

    const response = await POST(request({ signedPayload: 'payload' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ processed: false, status: 'in_flight' });
  });

  it('captures processing failures without exposing details', async () => {
    const error = new Error('bad payload');
    mockProcess.mockRejectedValueOnce(error);

    const response = await POST(request({ signedPayload: 'payload' }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to process notification' });
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { source: 'app_store_kilo_pass_notification' },
    });
  });
});

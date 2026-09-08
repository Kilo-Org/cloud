import { captureException } from '@sentry/nextjs';
import { OAuth2Client } from 'google-auth-library';

import { getEnvVariable } from '@/lib/dotenvx';
import { processGooglePlayKiloPassNotification } from '@/lib/kilo-pass/google-play-notifications';
import { POST } from './route';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/dotenvx', () => ({
  getEnvVariable: jest.fn(),
}));

jest.mock('@/lib/kilo-pass/google-play-notifications', () => ({
  processGooglePlayKiloPassNotification: jest.fn(),
}));

jest.mock('google-auth-library');

const mockVerifyIdToken = jest.fn();
const mockProcess = jest.mocked(processGooglePlayKiloPassNotification);
const mockGetEnvVariable = jest.mocked(getEnvVariable);

(OAuth2Client as unknown as jest.Mock).mockImplementation(() => ({
  verifyIdToken: mockVerifyIdToken,
}));

const AUDIENCE = 'https://app.example.com/api/kilo-pass/play/notifications';
const SERVICE_ACCOUNT_EMAIL = 'play-rtdn-push@example.iam.gserviceaccount.com';

function request(body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  const req = new Request('https://app.example.com/api/kilo-pass/play/notifications', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
  return req;
}

describe('POST /api/kilo-pass/play/notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProcess.mockResolvedValue({ processed: true });
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: SERVICE_ACCOUNT_EMAIL, email_verified: true }),
    });
    mockGetEnvVariable.mockImplementation(name => {
      if (name === 'GOOGLE_PLAY_RTDN_PUSH_AUDIENCE') return AUDIENCE;
      if (name === 'GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL') return SERVICE_ACCOUNT_EMAIL;
      return '';
    });
  });

  it('returns 401 when the Authorization bearer is missing', async () => {
    const response = await POST(request({ message: { data: 'payload' } }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('returns 401 when the OIDC token is invalid', async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error('invalid token'));

    const response = await POST(request({ message: { data: 'payload' } }, 'bad-token'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockVerifyIdToken).toHaveBeenCalledWith({
      idToken: 'bad-token',
      audience: AUDIENCE,
    });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('returns 401 when GOOGLE_PLAY_RTDN_PUSH_AUDIENCE is not configured', async () => {
    mockGetEnvVariable.mockImplementation(name =>
      name === 'GOOGLE_PLAY_RTDN_PUSH_AUDIENCE' ? '' : SERVICE_ACCOUNT_EMAIL
    );

    const response = await POST(request({ message: { data: 'payload' } }, 'valid-token'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('returns 401 when GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL is not configured', async () => {
    mockGetEnvVariable.mockImplementation(name =>
      name === 'GOOGLE_PLAY_RTDN_PUSH_AUDIENCE' ? AUDIENCE : ''
    );

    const response = await POST(request({ message: { data: 'payload' } }, 'valid-token'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('returns 401 when the token email does not match the service account', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ email: 'attacker@example.com', email_verified: true }),
    });

    const response = await POST(request({ message: { data: 'payload' } }, 'valid-token'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('returns 401 when the token email is not verified', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ email: SERVICE_ACCOUNT_EMAIL, email_verified: false }),
    });

    const response = await POST(request({ message: { data: 'payload' } }, 'valid-token'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('returns 401 when the token payload lacks an email', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ email_verified: true }),
    });

    const response = await POST(request({ message: { data: 'payload' } }, 'valid-token'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('returns 400 when the Pub/Sub message data is missing', async () => {
    const response = await POST(request({ message: {} }, 'valid-token'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing Pub/Sub message data' });
  });

  it('returns 400 when the request body is not JSON', async () => {
    const response = await POST(
      new Request('https://app.example.com/api/kilo-pass/play/notifications', {
        method: 'POST',
        body: 'not-json',
        headers: { 'content-type': 'application/json', authorization: 'Bearer valid-token' },
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing Pub/Sub message data' });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('processes Play notification payloads', async () => {
    const response = await POST(
      request({ message: { data: 'cGF5bG9hZA==', messageId: 'msg-1' } }, 'valid-token')
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: true });
    expect(mockProcess).toHaveBeenCalledWith({
      pubsubMessage: { data: 'cGF5bG9hZA==', messageId: 'msg-1' },
    });
  });

  it('treats already-processed duplicate notifications as idempotent success', async () => {
    mockProcess.mockResolvedValueOnce({ processed: true, status: 'already_processed' });

    const response = await POST(request({ message: { data: 'payload' } }, 'valid-token'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: true, status: 'already_processed' });
  });

  it('asks Pub/Sub to retry fresh in-flight duplicate notifications', async () => {
    mockProcess.mockResolvedValueOnce({ processed: false, status: 'in_flight' });

    const response = await POST(request({ message: { data: 'payload' } }, 'valid-token'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ processed: false, status: 'in_flight' });
  });

  it('captures processing failures without exposing details', async () => {
    const error = new Error('bad payload');
    mockProcess.mockRejectedValueOnce(error);

    const response = await POST(request({ message: { data: 'payload' } }, 'valid-token'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to process notification' });
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { source: 'google_play_kilo_pass_notification' },
    });
  });
});

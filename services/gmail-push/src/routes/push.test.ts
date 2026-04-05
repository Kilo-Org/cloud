import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, HonoContext } from '../types';
import { pushRoute } from './push';

vi.mock('../auth/oidc', () => ({
  validateOidcToken: vi.fn(),
}));

import { validateOidcToken } from '../auth/oidc';

const mockValidateOidc = vi.mocked(validateOidcToken);

const TEST_USER = 'user123';
const TEST_SA_EMAIL = 'gmail-push@my-project.iam.gserviceaccount.com';

function createApp(kiloFetch?: (req: Request) => Promise<Response>) {
  const app = new Hono<HonoContext>();
  const mockQueue = {
    send: vi.fn(),
  };

  const defaultKiloFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ gmailPushOidcEmail: TEST_SA_EMAIL }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

  app.use('*', async (c, next) => {
    c.env = {
      KILOCLAW: { fetch: kiloFetch ?? defaultKiloFetch } as unknown as Fetcher,
      OIDC_AUDIENCE_BASE: 'https://kiloclaw-gmail.kiloapps.io',
      INTERNAL_API_SECRET: { get: () => Promise.resolve('test-internal-secret') },
      GMAIL_PUSH_QUEUE: mockQueue as unknown as Queue,
      IDEMPOTENCY: {} as unknown as DurableObjectNamespace,
    } as unknown as AppEnv;
    await next();
  });

  app.route('/push', pushRoute);
  return { app, mockQueue };
}

describe('POST /push/user/:userId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acks request without authorization header', async () => {
    mockValidateOidc.mockResolvedValue({ valid: false, error: 'Missing authorization header' });
    const { app } = createApp();

    const res = await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      body: JSON.stringify({ message: { data: 'dGVzdA==' } }),
    });

    expect(res.status).toBe(200);
  });

  it('acks invalid OIDC token', async () => {
    mockValidateOidc.mockResolvedValue({ valid: false, error: 'bad token' });
    const { app } = createApp();

    const res = await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      headers: { authorization: 'Bearer bad-token' },
      body: JSON.stringify({ message: { data: 'dGVzdA==' } }),
    });

    expect(res.status).toBe(200);
  });

  it('passes audience and allowedEmail to OIDC validator', async () => {
    mockValidateOidc.mockResolvedValue({ valid: true, email: TEST_SA_EMAIL });
    const { app } = createApp();

    await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ message: { data: 'dGVzdA==' } }),
    });

    expect(mockValidateOidc).toHaveBeenCalledWith(
      'Bearer valid-token',
      `https://kiloclaw-gmail.kiloapps.io/push/user/${TEST_USER}`,
      TEST_SA_EMAIL
    );
  });

  it('enqueues message and returns 200 for valid OIDC with matching email', async () => {
    mockValidateOidc.mockResolvedValue({ valid: true, email: TEST_SA_EMAIL });
    const { app, mockQueue } = createApp();
    const pubSubBody = JSON.stringify({ message: { data: 'dGVzdA==', messageId: '123' } });

    const res = await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': 'application/json',
      },
      body: pubSubBody,
    });

    expect(res.status).toBe(200);
    expect(mockQueue.send).toHaveBeenCalledOnce();
    expect(mockQueue.send).toHaveBeenCalledWith({
      userId: TEST_USER,
      pubSubBody,
      messageId: '123',
    });
  });

  it('acks when OIDC email does not match stored email', async () => {
    mockValidateOidc.mockResolvedValue({
      valid: false,
      error: 'Unexpected email: attacker-sa@evil-project.iam.gserviceaccount.com',
    });
    const { app, mockQueue } = createApp();

    const res = await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ message: { data: 'dGVzdA==' } }),
    });

    expect(res.status).toBe(200);
    expect(mockQueue.send).not.toHaveBeenCalled();
  });

  it('acks stale delivery when no OIDC email is stored (null)', async () => {
    const kiloFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ gmailPushOidcEmail: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    const { app, mockQueue } = createApp(kiloFetch);

    const res = await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ message: { data: 'dGVzdA==' } }),
    });

    expect(res.status).toBe(200);
    expect(mockQueue.send).not.toHaveBeenCalled();
    expect(mockValidateOidc).not.toHaveBeenCalled();
  });

  it('acks when OIDC email lookup fails', async () => {
    const kiloFetch = () => Promise.resolve(new Response('Internal error', { status: 500 }));
    const { app, mockQueue } = createApp(kiloFetch);

    const res = await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ message: { data: 'dGVzdA==' } }),
    });

    expect(res.status).toBe(200);
    expect(mockQueue.send).not.toHaveBeenCalled();
    expect(mockValidateOidc).not.toHaveBeenCalled();
  });

  it('acks oversized payload without enqueuing', async () => {
    mockValidateOidc.mockResolvedValue({ valid: true, email: TEST_SA_EMAIL });
    const { app, mockQueue } = createApp();

    const res = await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: 'x'.repeat(65_537),
    });

    expect(res.status).toBe(200);
    expect(mockQueue.send).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '../db';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock('../db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getWorkerDb: vi.fn(() => ({})),
    getInstanceById: vi.fn(),
  };
});

import { platform } from './platform';
import { deriveGatewayToken } from '../auth/gateway-token';
import { getInstanceById } from '../db';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-1';
const SANDBOX_ID = 'ki_11111111111141118111111111111111';
const GATEWAY_TOKEN_SECRET = 'secret';

function makeEnv(overrides: Record<string, unknown> = {}) {
  const getStatus = vi.fn().mockResolvedValue({
    userId: USER_ID,
    sandboxId: SANDBOX_ID,
    status: 'running',
  });
  const getRoutingTarget = vi.fn().mockResolvedValue({
    origin: 'https://acct-test.fly.dev',
    headers: { 'fly-force-instance-id': 'machine-1' },
  });
  const resolveDoKey = vi.fn().mockResolvedValue(INSTANCE_ID);
  const idFromName = vi.fn((id: string) => id);

  return {
    env: {
      HYPERDRIVE: { connectionString: 'postgresql://fake' },
      GATEWAY_TOKEN_SECRET,
      KILOCLAW_INSTANCE: {
        idFromName,
        get: () => ({ getStatus, getRoutingTarget }),
      },
      KILOCLAW_REGISTRY: {
        idFromName: vi.fn((id: string) => id),
        get: () => ({ resolveDoKey }),
      },
      KILOCLAW_AE: { writeDataPoint: vi.fn() },
      KV_CLAW_CACHE: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
        getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
      },
      ...overrides,
    } as never,
    getStatus,
    getRoutingTarget,
    resolveDoKey,
    idFromName,
  };
}

function deliveryBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    instanceId: INSTANCE_ID,
    messageId: '<msg-1@example.com>',
    from: 'sender@example.com',
    to: 'ki-11111111111141118111111111111111@example.com',
    subject: 'Hello',
    text: 'Email body',
    receivedAt: '2026-04-13T12:00:00.000Z',
    ...overrides,
  });
}

describe('POST /inbound-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
    vi.mocked(getInstanceById).mockResolvedValue({
      id: INSTANCE_ID,
      userId: USER_ID,
      sandboxId: SANDBOX_ID,
      orgId: null,
    });
  });

  it('delivers inbound email to the routed controller hook endpoint', async () => {
    const { env, resolveDoKey, idFromName } = makeEnv();

    const response = await platform.request(
      '/inbound-email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: deliveryBody(),
      },
      env
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true });
    expect(resolveDoKey).toHaveBeenCalledWith(`user:${USER_ID}`, INSTANCE_ID);
    expect(idFromName).toHaveBeenCalledWith(INSTANCE_ID);

    const expectedGatewayToken = await deriveGatewayToken(SANDBOX_ID, GATEWAY_TOKEN_SECRET);
    const mockFetch = vi.mocked(fetch);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://acct-test.fly.dev/_kilo/hooks/email');
    expect(init?.headers).toEqual(
      expect.objectContaining({
        authorization: `Bearer ${expectedGatewayToken}`,
        'content-type': 'application/json',
        'fly-force-instance-id': 'machine-1',
      })
    );
    expect(JSON.parse(init?.body as string)).toEqual(
      expect.objectContaining({
        sessionKey: 'inbound-email:2026-04-13-hello',
        messageId: '<msg-1@example.com>',
        text: 'Email body',
      })
    );
  });

  it('sanitizes subject punctuation in the readable session key', async () => {
    const { env } = makeEnv();

    const response = await platform.request(
      '/inbound-email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: deliveryBody({ subject: 'Re: Hello, World! (Part 2)' }),
      },
      env
    );

    expect(response.status).toBe(202);
    const mockFetch = vi.mocked(fetch);
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual(
      expect.objectContaining({
        sessionKey: 'inbound-email:2026-04-13-re-hello-world-part-2',
      })
    );
  });

  it('uses a readable fallback session key for blank subjects', async () => {
    const { env } = makeEnv();

    const response = await platform.request(
      '/inbound-email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: deliveryBody({ subject: '   ' }),
      },
      env
    );

    expect(response.status).toBe(202);
    const mockFetch = vi.mocked(fetch);
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual(
      expect.objectContaining({
        sessionKey: 'inbound-email:2026-04-13-no-subject',
      })
    );
  });

  it('returns 404 for unknown instances', async () => {
    vi.mocked(getInstanceById).mockResolvedValue(null);
    const { env } = makeEnv();

    const response = await platform.request(
      '/inbound-email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: deliveryBody(),
      },
      env
    );

    expect(response.status).toBe(404);
  });

  it('returns 503 when instance is not running', async () => {
    const { env, getStatus } = makeEnv();
    getStatus.mockResolvedValueOnce({ userId: USER_ID, sandboxId: SANDBOX_ID, status: 'stopped' });

    const response = await platform.request(
      '/inbound-email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: deliveryBody(),
      },
      env
    );

    expect(response.status).toBe(503);
  });

  it('uses org registry key for org-owned instances', async () => {
    vi.mocked(getInstanceById).mockResolvedValue({
      id: INSTANCE_ID,
      userId: USER_ID,
      sandboxId: SANDBOX_ID,
      orgId: '22222222-2222-4222-8222-222222222222',
    });
    const { env, resolveDoKey } = makeEnv();

    const response = await platform.request(
      '/inbound-email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: deliveryBody(),
      },
      env
    );

    expect(response.status).toBe(202);
    expect(resolveDoKey).toHaveBeenCalledWith(
      'org:22222222-2222-4222-8222-222222222222',
      INSTANCE_ID
    );
  });
});

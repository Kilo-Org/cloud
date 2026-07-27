import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchInternalPushCore } from '../lib/internal-dispatch-push';

vi.mock('../lib/internal-dispatch-push', () => ({
  dispatchInternalPushCore: vi.fn(async () => ({
    perRecipient: [{ userId: 'user-a', outcome: 'delivered' as const }],
  })),
}));

const mockDispatchInternalPushCore = vi.mocked(dispatchInternalPushCore);

const TEST_INTERNAL_SECRET = 'test-internal-api-secret';

const validLowBalanceBody = {
  kind: 'low_balance' as const,
  recipientUserIds: ['user-a'],
  organizationId: 'org-1',
  organizationName: 'Acme Corp',
  minimumBalanceUsd: 10,
};

function dispatchRequest(options: {
  secret?: string | null;
  body?: unknown;
  rawBody?: string;
}): RequestInit {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.secret !== null && options.secret !== undefined) {
    headers['X-Internal-Secret'] = options.secret;
  } else if (options.secret === undefined) {
    // omit header
  }
  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : JSON.stringify(options.body ?? validLowBalanceBody);
  return { method: 'POST', headers, body };
}

describe('POST /internal/v1/dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(env.INTERNAL_API_SECRET, 'get').mockResolvedValue(TEST_INTERNAL_SECRET);
    mockDispatchInternalPushCore.mockResolvedValue({
      perRecipient: [{ userId: 'user-a', outcome: 'delivered' }],
    });
  });

  it('returns 401 when X-Internal-Secret header is missing', async () => {
    const res = await SELF.fetch(
      'https://example.com/internal/v1/dispatch',
      dispatchRequest({ secret: null })
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockDispatchInternalPushCore).not.toHaveBeenCalled();
  });

  it('returns 401 when INTERNAL_API_SECRET binding is empty', async () => {
    vi.spyOn(env.INTERNAL_API_SECRET, 'get').mockResolvedValue('');

    const res = await SELF.fetch(
      'https://example.com/internal/v1/dispatch',
      dispatchRequest({ secret: TEST_INTERNAL_SECRET })
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockDispatchInternalPushCore).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Internal-Secret is wrong (equal length)', async () => {
    // Same length as TEST_INTERNAL_SECRET so timingSafeEqual value-compare runs.
    const wrongEqualLength = 'x'.repeat(TEST_INTERNAL_SECRET.length);
    const res = await SELF.fetch(
      'https://example.com/internal/v1/dispatch',
      dispatchRequest({ secret: wrongEqualLength })
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockDispatchInternalPushCore).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Internal-Secret is wrong (different length)', async () => {
    const res = await SELF.fetch(
      'https://example.com/internal/v1/dispatch',
      dispatchRequest({ secret: 'wrong-secret' })
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockDispatchInternalPushCore).not.toHaveBeenCalled();
  });

  it('returns 400 when body is malformed JSON', async () => {
    const res = await SELF.fetch(
      'https://example.com/internal/v1/dispatch',
      dispatchRequest({
        secret: TEST_INTERNAL_SECRET,
        rawBody: '{not-valid-json',
      })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid body' });
    expect(mockDispatchInternalPushCore).not.toHaveBeenCalled();
  });

  it('returns 400 when body fails internalDispatchRequestSchema', async () => {
    const res = await SELF.fetch(
      'https://example.com/internal/v1/dispatch',
      dispatchRequest({
        secret: TEST_INTERNAL_SECRET,
        body: { kind: 'low_balance' },
      })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid body' });
    expect(mockDispatchInternalPushCore).not.toHaveBeenCalled();
  });

  it('returns 2xx and invokes dispatch core with the parsed request', async () => {
    const res = await SELF.fetch(
      'https://example.com/internal/v1/dispatch',
      dispatchRequest({ secret: TEST_INTERNAL_SECRET, body: validLowBalanceBody })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      perRecipient: [{ userId: 'user-a', outcome: 'delivered' }],
    });
    expect(mockDispatchInternalPushCore).toHaveBeenCalledTimes(1);
    expect(mockDispatchInternalPushCore).toHaveBeenCalledWith(
      validLowBalanceBody,
      expect.objectContaining({
        getRecipientDOStub: expect.any(Function),
        readPreferences: expect.any(Function),
      })
    );
  });
});

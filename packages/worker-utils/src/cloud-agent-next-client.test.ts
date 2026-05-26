import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createCloudAgentNextFetchClient,
  CloudAgentNextBillingError,
  CloudAgentNextError,
} from './cloud-agent-next-client.js';

const BASE_URL = 'https://cloud-agent-next.test';

function mockFetch(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CloudAgentNextFetchClient billing error detection', () => {
  it('throws CloudAgentNextBillingError on 402 status', async () => {
    vi.stubGlobal('fetch', mockFetch(402, 'Payment Required'));
    const client = createCloudAgentNextFetchClient(BASE_URL);

    await expect(
      client.prepareSession(
        {},
        {
          prompt: 'test',
          mode: 'code',
          model: 'test-model',
        }
      )
    ).rejects.toThrow(CloudAgentNextBillingError);
  });

  it('throws CloudAgentNextBillingError when body contains "Insufficient credits"', async () => {
    vi.stubGlobal('fetch', mockFetch(400, 'Insufficient credits: $1 minimum required'));
    const client = createCloudAgentNextFetchClient(BASE_URL);

    await expect(
      client.prepareSession(
        {},
        {
          prompt: 'test',
          mode: 'code',
          model: 'test-model',
        }
      )
    ).rejects.toThrow(CloudAgentNextBillingError);
  });

  it('throws CloudAgentNextBillingError when body contains "paid model"', async () => {
    vi.stubGlobal('fetch', mockFetch(403, 'This is a paid model, add credits to continue'));
    const client = createCloudAgentNextFetchClient(BASE_URL);

    await expect(
      client.initiateFromPreparedSession({}, { cloudAgentSessionId: 'agent_123' })
    ).rejects.toThrow(CloudAgentNextBillingError);
  });

  it('throws CloudAgentNextBillingError when body contains "Credits Required"', async () => {
    vi.stubGlobal('fetch', mockFetch(402, 'Credits Required'));
    const client = createCloudAgentNextFetchClient(BASE_URL);

    await expect(
      client.sendMessageV2(
        {},
        {
          cloudAgentSessionId: 'agent_123',
          prompt: 'review',
          mode: 'code',
          model: 'test',
        }
      )
    ).rejects.toThrow(CloudAgentNextBillingError);
  });

  it('sets terminalReason to "billing" on billing errors', async () => {
    vi.stubGlobal('fetch', mockFetch(402, 'Payment Required'));
    const client = createCloudAgentNextFetchClient(BASE_URL);

    try {
      await client.prepareSession(
        {},
        {
          prompt: 'test',
          mode: 'code',
          model: 'test-model',
        }
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAgentNextBillingError);
      const billingError = error as CloudAgentNextBillingError;
      expect(billingError.terminalReason).toBe('billing');
      expect(billingError.procedure).toBe('prepareSession');
      expect(billingError.status).toBe(402);
    }
  });

  it('throws generic CloudAgentNextError for non-billing failures', async () => {
    vi.stubGlobal('fetch', mockFetch(500, 'Internal Server Error'));
    const client = createCloudAgentNextFetchClient(BASE_URL);

    await expect(
      client.prepareSession(
        {},
        {
          prompt: 'test',
          mode: 'code',
          model: 'test-model',
        }
      )
    ).rejects.toThrow(CloudAgentNextError);

    await expect(
      client.prepareSession(
        {},
        {
          prompt: 'test',
          mode: 'code',
          model: 'test-model',
        }
      )
    ).rejects.not.toThrow(CloudAgentNextBillingError);
  });

  it('preserves procedure metadata on generic errors', async () => {
    vi.stubGlobal('fetch', mockFetch(500, 'Internal Server Error'));
    const client = createCloudAgentNextFetchClient(BASE_URL);

    try {
      await client.prepareSession(
        {},
        {
          prompt: 'test',
          mode: 'code',
          model: 'test-model',
        }
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAgentNextError);
      const cloudAgentError = error as CloudAgentNextError;
      expect(cloudAgentError.procedure).toBe('prepareSession');
      expect(cloudAgentError.status).toBe(500);
      expect(cloudAgentError.body).toBe('Internal Server Error');
    }
  });

  it('throws generic CloudAgentNextError for 404', async () => {
    vi.stubGlobal('fetch', mockFetch(404, 'Not found'));
    const client = createCloudAgentNextFetchClient(BASE_URL);

    await expect(
      client.sendMessageV2(
        {},
        {
          cloudAgentSessionId: 'agent_123',
          prompt: 'test',
          mode: 'code',
          model: 'test',
        }
      )
    ).rejects.toThrow(CloudAgentNextError);

    await expect(
      client.sendMessageV2(
        {},
        {
          cloudAgentSessionId: 'agent_123',
          prompt: 'test',
          mode: 'code',
          model: 'test',
        }
      )
    ).rejects.not.toThrow(CloudAgentNextBillingError);
  });
});

describe('CloudAgentNextFetchClient getSessionHealth', () => {
  it('posts to getSessionHealth and parses a healthy response', async () => {
    const fetchMock = mockFetch(200, {
      result: {
        data: {
          cloudAgentSessionId: 'agent_123',
          sandboxId: 'ses-abc123',
          sandboxStatus: 'healthy',
          executionHealth: 'none',
        },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createCloudAgentNextFetchClient(BASE_URL);

    const result = await client.getSessionHealth(
      { Authorization: 'Bearer token' },
      { cloudAgentSessionId: 'agent_123' }
    );

    expect(result).toEqual({
      cloudAgentSessionId: 'agent_123',
      sandboxId: 'ses-abc123',
      sandboxStatus: 'healthy',
      executionHealth: 'none',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/trpc/getSessionHealth`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({ cloudAgentSessionId: 'agent_123' }),
      })
    );
  });

  it('rejects malformed health responses', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        result: {
          data: {
            cloudAgentSessionId: 'agent_123',
            sandboxStatus: 'on-fire',
            executionHealth: 'none',
          },
        },
      })
    );
    const client = createCloudAgentNextFetchClient(BASE_URL);

    await expect(client.getSessionHealth({}, { cloudAgentSessionId: 'agent_123' })).rejects.toThrow(
      'Unexpected getSessionHealth response shape'
    );
  });
});

describe('CloudAgentNextFetchClient legacy execution responses', () => {
  it('parses initiateFromPreparedSession response with executionId as messageId alias', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        result: {
          data: {
            cloudAgentSessionId: 'agent_123',
            status: 'started',
            streamUrl: '/stream?cloudAgentSessionId=agent_123',
            messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
            executionId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
            delivery: 'queued',
          },
        },
      })
    );
    const client = createCloudAgentNextFetchClient(BASE_URL);

    const result = await client.initiateFromPreparedSession(
      {},
      { cloudAgentSessionId: 'agent_123' }
    );

    expect(result.executionId).toBe('msg_018f1e2d3c4bAbCdEfGhIjKlMn');
  });

  it('parses sendMessageV2 response with executionId as messageId alias', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        result: {
          data: {
            cloudAgentSessionId: 'agent_123',
            status: 'started',
            streamUrl: '/stream?cloudAgentSessionId=agent_123',
            messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
            executionId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
            delivery: 'sent',
          },
        },
      })
    );
    const client = createCloudAgentNextFetchClient(BASE_URL);

    const result = await client.sendMessageV2(
      {},
      {
        cloudAgentSessionId: 'agent_123',
        prompt: 'follow up',
        mode: 'code',
        model: 'test-model',
      }
    );

    expect(result.executionId).toBe('msg_018f1e2d3c4bAbCdEfGhIjKlMn');
  });
});

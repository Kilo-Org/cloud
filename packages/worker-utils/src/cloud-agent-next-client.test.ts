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

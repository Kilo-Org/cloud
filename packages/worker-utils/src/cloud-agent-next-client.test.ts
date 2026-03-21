import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCloudAgentNextFetchClient } from './cloud-agent-next-client.js';

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

describe('CloudAgentNextFetchClient error handling', () => {
  it('throws on 500 server error from prepareSession', async () => {
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
    ).rejects.toThrow('prepareSession failed (500)');
  });

  it('throws on 404 from sendMessageV2', async () => {
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
    ).rejects.toThrow('sendMessageV2 failed (404)');
  });

  it('throws on 402 payment required', async () => {
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
    ).rejects.toThrow('prepareSession failed (402)');
  });

  it('throws on unexpected response shape from prepareSession', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, { result: { data: { unexpectedField: true } } })
    );
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
    ).rejects.toThrow('Unexpected prepareSession response shape');
  });

  it('throws on unexpected response shape from sendMessageV2', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, { result: { data: { wrongShape: 1 } } })
    );
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
    ).rejects.toThrow('Unexpected sendMessageV2 response shape');
  });

  it('throws on missing result.data envelope', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, { result: {} })
    );
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
    ).rejects.toThrow('Unexpected prepareSession response shape');
  });
});

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { isOpenAiModelServed, resetServedModelIdsCache } from './served-models';
import { OPENAI_CHATGPT_API_URL } from './upstream';

const fetchMock = jest.fn<typeof fetch>();

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ object: 'list', data: ids.map(id => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('isOpenAiModelServed', () => {
  beforeEach(() => {
    resetServedModelIdsCache();
    fetchMock.mockReset();
    global.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    resetServedModelIdsCache();
    jest.restoreAllMocks();
  });

  it('asks the delegated upstream for its model list', async () => {
    fetchMock.mockResolvedValue(modelsResponse(['gpt-5-nano']));

    await isOpenAiModelServed('partner-key', 'gpt-5-nano');

    expect(fetchMock).toHaveBeenCalledWith(
      `${OPENAI_CHATGPT_API_URL}/models`,
      expect.objectContaining({
        headers: { authorization: 'Bearer partner-key' },
      })
    );
  });

  it('rejects a model the project does not serve', async () => {
    fetchMock.mockResolvedValue(modelsResponse(['gpt-5.6-luna', 'gpt-5-nano']));

    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna')).resolves.toBe(true);
    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna-pro')).resolves.toBe(false);
  });

  it('fetches the list once and reuses it', async () => {
    fetchMock.mockResolvedValue(modelsResponse(['gpt-5-nano']));

    await isOpenAiModelServed('partner-key', 'gpt-5-nano');
    await isOpenAiModelServed('partner-key', 'gpt-5-nano');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The lookup is not stored by the framework: a stored copy would keep
    // answering with an unusable body past the short failure window.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('next');
  });

  it('keeps the route when the list cannot be read', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));

    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna-pro')).resolves.toBe(true);
  });

  it('keeps the route when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna-pro')).resolves.toBe(true);
  });

  it.each([
    ['no data field', { object: 'list' }],
    ['an empty list', { object: 'list', data: [] }],
    ['entries without ids', { object: 'list', data: [{ object: 'model' }, {}] }],
  ])('treats a 200 with %s as a failed lookup', async (_label, payload) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna-pro')).resolves.toBe(true);
    // The unusable answer is remembered for the short failure window, not cached
    // as an empty catalog for the hour a real list is reused for.
    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna-pro')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-asks after the failure window instead of hiding the route for an hour', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: 'list' }), { status: 200 }))
      .mockResolvedValueOnce(modelsResponse(['gpt-5.6-luna']));

    await isOpenAiModelServed('partner-key', 'gpt-5.6-luna');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 30_000);
    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna')).resolves.toBe(true);
    // The recovered list is authoritative again and rejects the unserved slug.
    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna-pro')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves the ids it could read from a partially malformed list', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.6-luna' }, { id: 7 }] }), {
        status: 200,
      })
    );

    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna')).resolves.toBe(true);
    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna-pro')).resolves.toBe(false);
  });

  it('remembers a failed lookup instead of retrying it per request', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));

    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna')).resolves.toBe(true);
    await expect(isOpenAiModelServed('partner-key', 'gpt-5.6-luna')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries the lookup after the failure window passes', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));

    await isOpenAiModelServed('partner-key', 'gpt-5.6-luna');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 30_000);
    await isOpenAiModelServed('partner-key', 'gpt-5.6-luna');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the route without a key, and does not call OpenAI', async () => {
    await expect(isOpenAiModelServed('   ', 'gpt-5.6-luna-pro')).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

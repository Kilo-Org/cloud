import { E2BApiError, toE2BComputeStatus, validateE2BApiKey } from './e2b-client';

const API_KEY = 'opaque-test-api-key-without-a-provider-prefix';
const PROVIDER_DETAIL = 'private-provider-response-detail';
const sandbox = {
  templateID: 'template-test',
  sandboxID: 'sandbox-test',
  clientID: '',
  startedAt: '2026-09-03T12:00:00.000Z',
  endAt: '2026-09-03T12:05:00.000Z',
  cpuCount: 2,
  memoryMB: 512,
  diskSizeMB: 1024,
  state: 'running',
  envdVersion: '0.1.0',
};

let fetchMock: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request'));
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function expectSafeError(result: Promise<unknown>, code: E2BApiError['code']) {
  const error: unknown = await result.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(E2BApiError);
  if (!(error instanceof E2BApiError)) throw new Error('Expected an E2BApiError');
  expect(error.code).toBe(code);
  expect(error.message).toBe(new E2BApiError(code).message);
  expect(error.cause).toBeUndefined();
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  expect(serialized).not.toContain(API_KEY);
  expect(serialized).not.toContain(PROVIDER_DETAIL);
}

describe('E2B API key validation', () => {
  it('consumes one empty management-plane list page without creating a sandbox', async () => {
    const response = Response.json([]);
    fetchMock.mockResolvedValueOnce(response);

    await expect(validateE2BApiKey(API_KEY)).resolves.toBeUndefined();

    expect(response.bodyUsed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://api.e2b.app/v2/sandboxes?limit=1', {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-API-Key': API_KEY },
      signal: expect.any(AbortSignal),
      redirect: 'error',
      cache: 'no-store',
    });
  });

  it.each(['running', 'paused'])(
    'validates a %s result without following the next page',
    async state => {
      const response = Response.json(
        [{ ...sandbox, state, metadata: { token: API_KEY, detail: PROVIDER_DETAIL } }],
        { headers: { 'X-Next-Token': 'untrusted-next-page' } }
      );
      fetchMock.mockResolvedValueOnce(response);

      await expect(validateE2BApiKey(API_KEY)).resolves.toBeUndefined();
      expect(response.bodyUsed).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [429, 'TOO_MANY_REQUESTS'],
    [408, 'SERVICE_UNAVAILABLE'],
    [500, 'SERVICE_UNAVAILABLE'],
    [503, 'SERVICE_UNAVAILABLE'],
    [400, 'BAD_GATEWAY'],
    [404, 'BAD_GATEWAY'],
    [302, 'BAD_GATEWAY'],
  ] as const)('sanitizes HTTP %s without reading an error body', async (status, code) => {
    const response = Response.json(
      { error: `${API_KEY} ${PROVIDER_DETAIL}` },
      { status, statusText: PROVIDER_DETAIL }
    );
    fetchMock.mockResolvedValueOnce(response);

    await expectSafeError(validateE2BApiKey(API_KEY), code);
    expect(response.bodyUsed).toBe(false);
  });

  it('does not expose transport errors or causes and does not retry', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error(API_KEY, { cause: { headers: { secret: PROVIDER_DETAIL } } })
    );
    await expectSafeError(validateE2BApiKey(API_KEY), 'SERVICE_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirected response even if a transport ignored redirect:error', async () => {
    const response = Response.json([]);
    Object.defineProperty(response, 'redirected', { value: true });
    fetchMock.mockResolvedValueOnce(response);
    await expectSafeError(validateE2BApiKey(API_KEY), 'BAD_GATEWAY');
  });

  it.each([
    ['an object', { sandboxes: [], token: API_KEY }],
    ['a missing sandbox ID', [{ ...sandbox, sandboxID: undefined }]],
    ['an empty sandbox ID', [{ ...sandbox, sandboxID: '' }]],
    ['an unsupported state', [{ ...sandbox, state: 'stopped' }]],
    ['a malformed timestamp', [{ ...sandbox, endAt: PROVIDER_DETAIL }]],
    ['a missing resource field', [{ ...sandbox, cpuCount: undefined }]],
    ['a string resource field', [{ ...sandbox, memoryMB: '512' }]],
    ['more than one result', [sandbox, { ...sandbox, sandboxID: 'second-sandbox' }]],
  ])('rejects %s without retaining provider data', async (_name, body) => {
    fetchMock.mockResolvedValueOnce(Response.json(body));
    await expectSafeError(validateE2BApiKey(API_KEY), 'BAD_GATEWAY');
  });

  it('sanitizes malformed JSON and rejects non-JSON content types', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(`${API_KEY} ${PROVIDER_DETAIL}`, {
        headers: { 'content-type': 'application/json' },
      })
    );
    await expectSafeError(validateE2BApiKey(API_KEY), 'BAD_GATEWAY');
    fetchMock.mockResolvedValueOnce(
      new Response('[]', { headers: { 'content-type': 'text/html' } })
    );
    await expectSafeError(validateE2BApiKey(API_KEY), 'BAD_GATEWAY');
  });

  it('rejects a declared oversized response before consuming it', async () => {
    const response = Response.json([], { headers: { 'content-length': '65537' } });
    fetchMock.mockResolvedValueOnce(response);
    await expectSafeError(validateE2BApiKey(API_KEY), 'BAD_GATEWAY');
    expect(response.bodyUsed).toBe(false);
  });

  it.each([undefined, '2'])('caps streamed response bytes with content-length %s', async length => {
    const cancel = jest.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('é'.repeat(33_000)));
        },
        cancel,
      }),
      {
        headers: {
          'content-type': 'application/json',
          ...(length ? { 'content-length': length } : {}),
        },
      }
    );
    fetchMock.mockResolvedValueOnce(response);

    await expectSafeError(validateE2BApiKey(API_KEY), 'BAD_GATEWAY');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sanitizes a body stream error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(API_KEY, { cause: PROVIDER_DETAIL }));
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    );
    await expectSafeError(validateE2BApiKey(API_KEY), 'BAD_GATEWAY');
  });

  it('aborts a pending request at the operation deadline', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error(API_KEY)), {
            once: true,
          });
        })
    );
    const result = expectSafeError(validateE2BApiKey(API_KEY), 'SERVICE_UNAVAILABLE');
    await jest.advanceTimersByTimeAsync(10_000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the same deadline through a stalled body read', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementationOnce(async (_url, options) => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('['));
            options?.signal?.addEventListener('abort', () => controller.error(new Error(API_KEY)), {
              once: true,
            });
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    });
    const result = expectSafeError(validateE2BApiKey(API_KEY), 'SERVICE_UNAVAILABLE');
    await jest.advanceTimersByTimeAsync(10_000);
    await result;
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('E2B status serialization', () => {
  it('normalizes PostgreSQL timestamps to UTC ISO and excludes the encrypted envelope', () => {
    const row = {
      id: crypto.randomUUID(),
      organization_id: crypto.randomUUID(),
      consent_version: 'e2b-direct-v1' as const,
      consented_at: '2026-04-29 01:16:12.945+00',
      validated_at: '2026-04-29 03:16:12.945+02',
      created_at: '2026-04-29 01:16:13+00',
      api_key_encrypted: { private: API_KEY },
    };
    expect(toE2BComputeStatus(row)).toEqual({
      credentialId: row.id,
      organizationId: row.organization_id,
      consentVersion: 'e2b-direct-v1',
      consentedAt: '2026-04-29T01:16:12.945Z',
      validatedAt: '2026-04-29T01:16:12.945Z',
      createdAt: '2026-04-29T01:16:13.000Z',
    });
  });
});

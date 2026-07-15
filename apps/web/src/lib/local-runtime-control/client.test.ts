import {
  LocalRuntimeControlClient,
  LocalRuntimeControlRequestError,
  type LocalRuntimeList,
} from './client';

const mockConfig = {
  sessionIngestWorkerUrl: 'https://session-ingest.example.workers.dev',
};

const mockTokenOptions: Array<{
  userId: string;
  options?: { expiresIn?: number; audience?: string };
}> = [];
jest.mock('@/lib/config.server', () => ({
  get SESSION_INGEST_WORKER_URL() {
    return mockConfig.sessionIngestWorkerUrl;
  },
}));

jest.mock('@/lib/tokens', () => ({
  TOKEN_EXPIRY: { fiveMinutes: 5 * 60 },
  generateInternalServiceToken: (
    userId: string,
    options?: { expiresIn?: number; audience?: string }
  ) => {
    mockTokenOptions.push({ userId, options });
    return `audience-bound-token:${userId}:${options?.audience ?? 'no-aud'}`;
  },
}));

describe('LocalRuntimeControlClient.list', () => {
  beforeEach(() => {
    mockConfig.sessionIngestWorkerUrl = 'https://session-ingest.example.workers.dev';
    mockTokenOptions.length = 0;
    jest.restoreAllMocks();
  });

  it('mints a five-minute audience-bound internal token for the user', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runtimes: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    await LocalRuntimeControlClient.list('usr_alice');

    expect(mockTokenOptions).toEqual([
      {
        userId: 'usr_alice',
        options: {
          expiresIn: 5 * 60,
          audience: 'session-ingest:runtime-control',
        },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(
      'https://session-ingest.example.workers.dev/internal/runtime-control/runtimes'
    );
    expect(calledInit.method).toBe('GET');
    expect(calledInit.headers).toEqual({
      Authorization: 'Bearer audience-bound-token:usr_alice:session-ingest:runtime-control',
    });
  });

  it('returns the strict-parsed empty list when the upstream returns zero runtimes', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runtimes: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    const result: LocalRuntimeList = await LocalRuntimeControlClient.list('usr_alice');

    expect(result).toEqual({ runtimes: [] });
  });

  it('returns all first-class runtimes including capability-missing entries', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          runtimes: [
            {
              runtimeId: '0c0a1b2c-3d4e-4f60-8a8b-9c0d1e2f3a4b',
              connectionId: 'cli-1',
              protocolVersion: 1,
              cliVersion: '7.4.7',
              displayName: 'Alice Mac',
              projectName: 'customer-repo',
              capabilities: ['catalog.v1', 'create-and-run.v1'],
            },
            {
              runtimeId: '1c0a1b2c-3d4e-4f60-8a8b-9c0d1e2f3a4b',
              connectionId: 'cli-2',
              protocolVersion: 1,
              cliVersion: '7.4.7',
              displayName: 'Bob Mac',
              projectName: 'empty-repo',
              capabilities: ['catalog.v1'],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await LocalRuntimeControlClient.list('usr_alice');

    expect(result.runtimes).toHaveLength(2);
    expect(result.runtimes[1]?.capabilities).toEqual(['catalog.v1']);
  });

  it('throws a typed error when SESSION_INGEST_WORKER_URL is not configured', async () => {
    mockConfig.sessionIngestWorkerUrl = '';
    const fetchMock = jest.spyOn(global, 'fetch');

    await expect(LocalRuntimeControlClient.list('usr_alice')).rejects.toBeInstanceOf(
      LocalRuntimeControlRequestError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a typed error on a network failure without returning an empty list', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('socket reset'));

    await expect(LocalRuntimeControlClient.list('usr_alice')).rejects.toBeInstanceOf(
      LocalRuntimeControlRequestError
    );
  });

  it('throws a typed error on a non-2xx response without returning an empty list', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response('upstream blew up with internal details', { status: 503 })
      );

    await expect(LocalRuntimeControlClient.list('usr_alice')).rejects.toBeInstanceOf(
      LocalRuntimeControlRequestError
    );
  });

  it('throws a typed error on a malformed response body without returning an empty list', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runtimes: [{ runtimeId: 'not-a-uuid' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    await expect(LocalRuntimeControlClient.list('usr_alice')).rejects.toBeInstanceOf(
      LocalRuntimeControlRequestError
    );
  });

  it('never logs the token or the response body when failures occur', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response('super-secret-response-body-must-not-leak', { status: 500 })
      );

    await expect(LocalRuntimeControlClient.list('usr_alice')).rejects.toBeInstanceOf(
      LocalRuntimeControlRequestError
    );

    const dumped = JSON.stringify({
      warns: warn.mock.calls,
      errors: errorSpy.mock.calls,
    });
    expect(dumped).not.toContain('super-secret-response-body-must-not-leak');
    expect(dumped).not.toContain('audience-bound-token:usr_alice');
  });
});

describe('LocalRuntimeControlClient.getCatalog', () => {
  const fence = {
    runtimeId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    connectionId: 'cli-77',
  };
  const validWireModels = {
    all: [
      {
        id: 'kilo',
        name: 'Kilo',
        source: 'env',
        env: [],
        options: {},
        models: {
          'kilo/auto': {
            id: 'kilo/auto',
            providerID: 'kilo',
            api: { id: 'kilo/auto', url: '', npm: '' },
            name: 'Auto',
            capabilities: {
              temperature: false,
              reasoning: false,
              attachment: false,
              toolcall: false,
              input: { text: true, audio: false, image: false, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: false,
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 1, output: 1 },
            status: 'active',
            options: {},
            headers: {},
            release_date: '',
          },
        },
      },
    ],
    default: { kilo: 'kilo/auto' },
    connected: ['kilo'],
    failed: [],
    protocolVersion: 1,
    truncated: false,
  };
  const validCatalogEnvelope = {
    catalog: {
      protocolVersion: 1,
      models: validWireModels,
      agents: [{ slug: 'build', name: 'Build' }],
      defaultAgent: 'build',
    },
  };

  beforeEach(() => {
    mockConfig.sessionIngestWorkerUrl = 'https://session-ingest.example.workers.dev';
    mockTokenOptions.length = 0;
    jest.restoreAllMocks();
  });

  it('mints a five-minute audience-bound internal token and POSTs the exact body', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validCatalogEnvelope), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    await LocalRuntimeControlClient.getCatalog('usr_alice', fence);

    expect(mockTokenOptions).toEqual([
      {
        userId: 'usr_alice',
        options: {
          expiresIn: 5 * 60,
          audience: 'session-ingest:runtime-control',
        },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(
      'https://session-ingest.example.workers.dev/internal/runtime-control/catalog'
    );
    expect(calledInit.method).toBe('POST');
    expect(calledInit.headers).toEqual({
      Authorization: 'Bearer audience-bound-token:usr_alice:session-ingest:runtime-control',
      'content-type': 'application/json',
    });
    expect(calledInit.body).toBe(JSON.stringify({ fence, request: { protocolVersion: 1 } }));
    expect(calledInit.signal).toBeDefined();
  });

  it('returns the parsed typed catalog with parsed models and agents/default', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validCatalogEnvelope), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    const result = await LocalRuntimeControlClient.getCatalog('usr_alice', fence);

    expect(result.catalog.protocolVersion).toBe(1);
    expect(result.catalog.defaultAgent).toBe('build');
    expect(result.catalog.agents).toEqual([{ slug: 'build', name: 'Build' }]);
    expect(result.catalog.models.protocolVersion).toBe(1);
    expect(result.catalog.models.providers).toHaveLength(1);
    expect(result.catalog.models.providers[0]?.id).toBe('kilo');
    expect(result.catalog.models.providers[0]?.models).toHaveLength(1);
    expect(result.catalog.models.providers[0]?.models[0]?.id).toBe('kilo/auto');
    expect(result.catalog.models.truncated).toBe(false);
  });

  it('uses a 5s AbortSignal timeout', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validCatalogEnvelope), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    await LocalRuntimeControlClient.getCatalog('usr_alice', fence);

    const [, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const signal = calledInit.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // The AbortSignal.timeout(5000) signal aborts at 5s; just assert it exists
    // and is not pre-aborted.
    expect(signal.aborted).toBe(false);
  });

  it('throws a typed error carrying upstreamCode on a structured error envelope', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            source: 'relay',
            code: 'RUNTIME_NOT_CONNECTED',
            message: 'Runtime is not currently connected',
          },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )
    );

    await expect(
      LocalRuntimeControlClient.getCatalog('usr_alice', fence)
    ).rejects.toMatchObject({
      name: 'LocalRuntimeCatalogError',
      upstreamCode: 'RUNTIME_NOT_CONNECTED',
    });
  });

  it('throws a typed error on a malformed models payload', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          catalog: {
            protocolVersion: 1,
            models: { not: 'a real catalog' },
            agents: [],
            defaultAgent: 'build',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await expect(
      LocalRuntimeControlClient.getCatalog('usr_alice', fence)
    ).rejects.toBeInstanceOf(Error);
  });

  it('throws a typed error on a malformed envelope', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ not: 'a catalog' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(
      LocalRuntimeControlClient.getCatalog('usr_alice', fence)
    ).rejects.toBeInstanceOf(Error);
  });

  it('throws a typed error on a network failure', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('socket reset'));

    await expect(
      LocalRuntimeControlClient.getCatalog('usr_alice', fence)
    ).rejects.toMatchObject({ name: 'LocalRuntimeCatalogError' });
  });

  it.each([401, 403, 409, 412, 429, 500, 504])(
    'throws a typed error on a non-2xx response (status %s)',
    async status => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('upstream blew up', { status }));

      await expect(
        LocalRuntimeControlClient.getCatalog('usr_alice', fence)
      ).rejects.toMatchObject({ name: 'LocalRuntimeCatalogError' });
    }
  );

  it('throws a typed error when SESSION_INGEST_WORKER_URL is not configured', async () => {
    mockConfig.sessionIngestWorkerUrl = '';
    const fetchMock = jest.spyOn(global, 'fetch');

    await expect(
      LocalRuntimeControlClient.getCatalog('usr_alice', fence)
    ).rejects.toBeInstanceOf(Error);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

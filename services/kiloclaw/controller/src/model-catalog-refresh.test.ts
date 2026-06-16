import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchModelCatalog,
  refreshModelCatalog,
  startModelCatalogRefresh,
  stopModelCatalogRefresh,
} from './model-catalog-refresh';

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const sampleResponse = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: ['reasoning', 'tools'],
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
        input_cache_read: '0.0000003',
        input_cache_write: '0.00000375',
      },
      context_length: 1_000_000,
      top_provider: { max_completion_tokens: 64_000 },
    },
    {
      id: 'some/text-only',
      name: 'Text Only',
      architecture: { input_modalities: ['text'] },
      supported_parameters: ['tools'],
      pricing: { prompt: '0.000001', completion: '0.000002' },
      context_length: 128_000,
    },
  ],
};

const baseEnv = {
  KILOCODE_API_KEY: 'secret-key',
  KILOCODE_ORGANIZATION_ID: 'org-1',
} as unknown as NodeJS.ProcessEnv;

function makeConfig(): Record<string, unknown> {
  return {
    other: 'preserved',
    models: {
      providers: {
        kilocode: {
          baseUrl: 'https://api.kilo.ai/api/gateway/',
          api: 'openai-completions',
          models: [],
          headers: { 'X-KiloCode-OrganizationId': 'org-1' },
        },
      },
    },
  };
}

describe('fetchModelCatalog', () => {
  it('maps vision and text-only modalities, pricing, and reasoning', async () => {
    const deps = {
      fetch: vi.fn(async () => mockResponse(sampleResponse)),
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
    };

    const models = await fetchModelCatalog(baseEnv, deps);

    expect(models).toHaveLength(2);
    const sonnet = models[0];
    expect(sonnet.id).toBe('anthropic/claude-sonnet-4.6');
    expect(sonnet.input).toEqual(['text', 'image']);
    expect(sonnet.reasoning).toBe(true);
    expect(sonnet.contextWindow).toBe(1_000_000);
    expect(sonnet.maxTokens).toBe(64_000);
    // per-token string price -> per-million number
    expect(sonnet.cost.input).toBeCloseTo(3);
    expect(sonnet.cost.output).toBeCloseTo(15);

    const textOnly = models[1];
    expect(textOnly.input).toEqual(['text']);
    expect(textOnly.reasoning).toBe(false);
    expect(textOnly.maxTokens).toBe(128_000); // default when top_provider absent
  });

  it('sends auth, org, and feature headers', async () => {
    const fetchMock = vi.fn(async () => mockResponse(sampleResponse));
    await fetchModelCatalog(baseEnv, {
      fetch: fetchMock,
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.kilo.ai/api/gateway/models');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    expect(headers['X-KiloCode-OrganizationId']).toBe('org-1');
    expect(headers['x-kilocode-feature']).toBe('kiloclaw');
  });

  it('accepts null max_completion_tokens/context_length without rejecting the batch', async () => {
    const body = {
      data: [
        {
          id: 'm/nullable',
          architecture: { input_modalities: ['text', 'image'] },
          top_provider: { max_completion_tokens: null },
          context_length: null,
        },
      ],
    };
    const models = await fetchModelCatalog(baseEnv, {
      fetch: vi.fn(async () => mockResponse(body)),
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
    });

    expect(models).toHaveLength(1);
    expect(models[0].input).toEqual(['text', 'image']);
    expect(models[0].maxTokens).toBe(128_000);
    expect(models[0].contextWindow).toBe(1_000_000);
  });

  it('skips unparseable entries instead of failing the whole catalog', async () => {
    const body = {
      data: [
        { id: 'ok/model', architecture: { input_modalities: ['text'] } },
        { name: 'missing-id' },
        42,
      ],
    };
    const models = await fetchModelCatalog(baseEnv, {
      fetch: vi.fn(async () => mockResponse(body)),
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
    });

    expect(models.map(m => m.id)).toEqual(['ok/model']);
  });

  it('throws when the API key is missing', async () => {
    await expect(
      fetchModelCatalog({} as unknown as NodeJS.ProcessEnv, {
        fetch: vi.fn(),
        readConfig: vi.fn(),
        writeConfig: vi.fn(),
      })
    ).rejects.toThrow(/KILOCODE_API_KEY/);
  });

  it('throws on a non-OK gateway response', async () => {
    await expect(
      fetchModelCatalog(baseEnv, {
        fetch: vi.fn(async () => mockResponse({}, false, 503)),
        readConfig: vi.fn(),
        writeConfig: vi.fn(),
      })
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe('refreshModelCatalog', () => {
  it('writes mapped models while preserving other config fields', async () => {
    const writeConfig = vi.fn();
    const result = await refreshModelCatalog(baseEnv, '/cfg.json', {
      fetch: vi.fn(async () => mockResponse(sampleResponse)),
      readConfig: vi.fn(() => JSON.stringify(makeConfig())),
      writeConfig,
    });

    expect(result).toEqual({ written: true, count: 2 });
    const written = JSON.parse(writeConfig.mock.calls[0][1] as string);
    const kilocode = written.models.providers.kilocode;
    expect(kilocode.models).toHaveLength(2);
    expect(kilocode.models[0].input).toEqual(['text', 'image']);
    // untouched fields preserved
    expect(kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
    expect(kilocode.headers['X-KiloCode-OrganizationId']).toBe('org-1');
    expect(written.other).toBe('preserved');
  });

  it('skips the write when the catalog is byte-for-byte unchanged', async () => {
    const fetchMock = vi.fn(async () => mockResponse(sampleResponse));
    let stored = JSON.stringify(makeConfig());
    const writeConfig = vi.fn((_p: string, data: string) => {
      stored = data;
    });
    const deps = { fetch: fetchMock, readConfig: vi.fn(() => stored), writeConfig };

    const first = await refreshModelCatalog(baseEnv, '/cfg.json', deps);
    expect(first.written).toBe(true);

    const second = await refreshModelCatalog(baseEnv, '/cfg.json', deps);
    expect(second.written).toBe(false);
    expect(writeConfig).toHaveBeenCalledTimes(1);
  });

  it('skips the write when the kilocode provider block is absent', async () => {
    const writeConfig = vi.fn();
    const result = await refreshModelCatalog(baseEnv, '/cfg.json', {
      fetch: vi.fn(async () => mockResponse(sampleResponse)),
      readConfig: vi.fn(() => JSON.stringify({ models: { providers: {} } })),
      writeConfig,
    });

    expect(result).toEqual({ written: false, count: 0 });
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('skips the write when the gateway returns no models', async () => {
    const writeConfig = vi.fn();
    const result = await refreshModelCatalog(baseEnv, '/cfg.json', {
      fetch: vi.fn(async () => mockResponse({ data: [] })),
      readConfig: vi.fn(() => JSON.stringify(makeConfig())),
      writeConfig,
    });

    expect(result).toEqual({ written: false, count: 0 });
    expect(writeConfig).not.toHaveBeenCalled();
  });
});

describe('startModelCatalogRefresh', () => {
  afterEach(() => {
    stopModelCatalogRefresh();
    vi.useRealTimers();
  });

  function timerDeps() {
    return {
      fetch: vi.fn(async () => mockResponse(sampleResponse)),
      readConfig: vi.fn(() => JSON.stringify(makeConfig())),
      writeConfig: vi.fn(),
    };
  }

  it('does not fetch immediately on start', () => {
    vi.useFakeTimers();
    const deps = timerDeps();
    startModelCatalogRefresh(baseEnv, '/cfg.json', deps);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('fetches after the initial delay, then repeats daily', async () => {
    vi.useFakeTimers();
    const deps = timerDeps();
    startModelCatalogRefresh(baseEnv, '/cfg.json', deps);

    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(deps.fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it('is disabled when the API key is absent', async () => {
    vi.useFakeTimers();
    const deps = timerDeps();
    startModelCatalogRefresh({} as unknown as NodeJS.ProcessEnv, '/cfg.json', deps);

    await vi.advanceTimersByTimeAsync(30 * 1000 + 24 * 60 * 60 * 1000);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('does not leak timers on double-start', async () => {
    vi.useFakeTimers();
    const deps = timerDeps();
    startModelCatalogRefresh(baseEnv, '/cfg.json', deps);
    startModelCatalogRefresh(baseEnv, '/cfg.json', deps);

    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it('stop cancels the pending refresh', async () => {
    vi.useFakeTimers();
    const deps = timerDeps();
    startModelCatalogRefresh(baseEnv, '/cfg.json', deps);
    stopModelCatalogRefresh();

    await vi.advanceTimersByTimeAsync(30 * 1000 + 24 * 60 * 60 * 1000);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

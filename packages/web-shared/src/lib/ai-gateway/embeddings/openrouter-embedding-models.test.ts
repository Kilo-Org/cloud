import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { KILO_DEFAULT_EMBEDDING_MODEL } from '@kilocode/web-shared/lib/ai-gateway/embeddings/kilo-embedding-models';
import {
  getKiloEmbeddingModelCatalogFromDatabase,
  openRouterEmbeddingModelsMetadataSource,
  resetKiloEmbeddingModelCatalogCache,
} from '@kilocode/web-shared/lib/ai-gateway/embeddings/openrouter-embedding-models';

type StoredRow = { data: unknown; updated_at?: string };
const mockReadRows = jest.fn<Promise<Array<StoredRow>>, []>();

// Keep the shared metadata reader real, including parsing and live fallback. Mock only the
// database and network boundaries so missing, corrupt, and rejected reads are deterministic.
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { select: jest.fn(), insert: jest.fn() },
  readDb: {
    select: jest.fn(() => ({
      from: () => ({ where: () => ({ limit: () => mockReadRows() }) }),
    })),
    insert: jest.fn(),
  },
}));

const TTL_MS = 300_000;
const FAILURE_BACKOFF_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
const START_MS = 1_000_000;
const initialModel = { id: 'vendor/first-embed', name: 'First Embed' };
const addedModel = { id: 'vendor/new-embed', name: 'New Embed' };
let clock: jest.SpiedFunction<typeof Date.now>;
let fetchSpy: jest.SpiedFunction<typeof fetch>;

function store(models: Array<{ id: string; name: string }>) {
  mockReadRows.mockResolvedValue([{ data: { data: models } }]);
}

function upstreamModels(models: Array<{ id: string; name: string }>) {
  return Response.json({ data: models, total_count: models.length, links: { next: null } });
}

const upstreamFailures = ['HTTP', 'invalid inventory', 'invalid JSON', 'timeout'] as const;

function failUpstream(kind: (typeof upstreamFailures)[number]) {
  switch (kind) {
    case 'HTTP':
      fetchSpy.mockResolvedValue(new Response(null, { status: 503 }));
      break;
    case 'invalid inventory':
      fetchSpy.mockResolvedValue(Response.json({ data: [] }));
      break;
    case 'invalid JSON':
      fetchSpy.mockResolvedValue(new Response('not JSON'));
      break;
    case 'timeout': {
      const controller = new AbortController();
      jest.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
      fetchSpy.mockImplementation(
        async () =>
          await new Promise<Response>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
              once: true,
            });
            controller.abort(new DOMException('Upstream timed out', 'TimeoutError'));
          })
      );
      return controller.signal;
    }
  }
  return undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReadRows.mockReset();
  store([initialModel]);
  clock = jest.spyOn(Date, 'now').mockReturnValue(START_MS);
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Unexpected network fetch'));
  resetKiloEmbeddingModelCatalogCache();
});

afterEach(() => {
  expect(db.select).not.toHaveBeenCalled();
  expect(db.insert).not.toHaveBeenCalled();
  expect(readDb.insert).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

describe('openRouterEmbeddingModelsMetadataSource', () => {
  it('requests the full inventory without offset or limit and projects only IDs/names', () => {
    expect(openRouterEmbeddingModelsMetadataSource.url).toBe(
      'https://openrouter.ai/api/v1/embeddings/models'
    );
    expect(openRouterEmbeddingModelsMetadataSource.timeoutMs).toBe(FETCH_TIMEOUT_MS);
    expect(
      openRouterEmbeddingModelsMetadataSource.parse({
        data: [{ ...initialModel, supported_parameters: [], description: '1024 dimensions' }],
        total_count: 1,
        links: { next: null },
      })
    ).toEqual({ data: [initialModel] });
  });

  it.each([
    ['empty inventory', { data: [] }],
    ['missing inventory', {}],
    ['invalid inventory', { data: 'not-an-array' }],
    ['invalid member', { data: [initialModel, { id: 'vendor/invalid' }] }],
    ['empty ID', { data: [{ id: '', name: 'Invalid' }] }],
    ['empty name', { data: [{ id: 'vendor/invalid', name: '' }] }],
    ['duplicate ID', { data: [initialModel, initialModel] }],
    ['next page', { data: [initialModel], links: { next: '/api/v1/embeddings/models?offset=1' } }],
    ['larger total', { data: [initialModel], total_count: 2 }],
    ['smaller total', { data: [initialModel], total_count: 0 }],
    ['invalid total', { data: [initialModel], total_count: '1' }],
    ['invalid pagination', { data: [initialModel], links: { next: 1 } }],
  ])('rejects the whole payload for %s', (_label, raw) => {
    expect(() => openRouterEmbeddingModelsMetadataSource.parse(raw)).toThrow();
  });
});

describe('getKiloEmbeddingModelCatalogFromDatabase', () => {
  it('reads through the replica and serves cached hits without database or network work', async () => {
    const catalog = await getKiloEmbeddingModelCatalogFromDatabase();
    expect(catalog).toEqual({
      defaultModel: initialModel.id,
      models: [{ ...initialModel, scoreThreshold: 0.35 }],
      aliases: {},
    });

    clock.mockReturnValue(START_MS + TTL_MS - 1);
    expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBe(catalog);
    expect(readDb.select).toHaveBeenCalledTimes(1);
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses a stale but valid stored snapshot without fetching upstream, even after cache expiry', async () => {
    mockReadRows.mockResolvedValue([
      { data: { data: [initialModel] }, updated_at: '2000-01-01T00:00:00Z' },
    ]);

    expect((await getKiloEmbeddingModelCatalogFromDatabase())?.defaultModel).toBe(initialModel.id);
    clock.mockReturnValue(START_MS + TTL_MS);
    expect((await getKiloEmbeddingModelCatalogFromDatabase())?.defaultModel).toBe(initialModel.id);
    expect(mockReadRows).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['missing', 'corrupt', 'error'])(
    'fetches upstream for a cold %s stored snapshot and caches the catalog',
    async kind => {
      if (kind === 'missing') mockReadRows.mockResolvedValue([]);
      else if (kind === 'corrupt') mockReadRows.mockResolvedValue([{ data: { invalid: true } }]);
      else mockReadRows.mockRejectedValue(new Error('Replica unavailable'));
      fetchSpy.mockResolvedValue(upstreamModels([addedModel]));
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');

      const catalog = await getKiloEmbeddingModelCatalogFromDatabase();
      expect(catalog).toEqual({
        defaultModel: addedModel.id,
        models: [{ ...addedModel, scoreThreshold: 0.35 }],
        aliases: {},
      });
      expect(fetchSpy).toHaveBeenCalledWith(openRouterEmbeddingModelsMetadataSource.url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      });
      expect(timeoutSpy).toHaveBeenCalledWith(FETCH_TIMEOUT_MS);

      clock.mockReturnValue(START_MS + TTL_MS - 1);
      expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBe(catalog);
      expect(mockReadRows).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves known Kilo metadata, uses upstream names, and keeps only discovered aliases', async () => {
    store([
      { id: 'mistralai/codestral-embed-2505', name: 'Upstream Codestral' },
      { id: KILO_DEFAULT_EMBEDDING_MODEL, name: 'Upstream Mistral' },
      { id: 'openai/text-embedding-3-small', name: 'Upstream OpenAI' },
    ]);

    expect(await getKiloEmbeddingModelCatalogFromDatabase()).toEqual({
      defaultModel: KILO_DEFAULT_EMBEDDING_MODEL,
      models: [
        {
          id: 'mistralai/codestral-embed-2505',
          name: 'Upstream Codestral',
          dimension: 1536,
          scoreThreshold: 0.35,
          note: 'code',
          dimensionMode: 'fixed',
        },
        {
          id: KILO_DEFAULT_EMBEDDING_MODEL,
          name: 'Upstream Mistral',
          dimension: 1024,
          scoreThreshold: 0.35,
          dimensionMode: 'fixed',
        },
        {
          id: 'openai/text-embedding-3-small',
          name: 'Upstream OpenAI',
          dimension: 1536,
          scoreThreshold: 0.4,
        },
      ],
      aliases: {
        'codestral-embed-2505': 'mistralai/codestral-embed-2505',
        'mistral-embed-2312': KILO_DEFAULT_EMBEDDING_MODEL,
        'text-embedding-3-small': 'openai/text-embedding-3-small',
      },
    });
  });

  it('omits unknown dimensions and never infers fixed support from upstream fields', async () => {
    mockReadRows.mockResolvedValue([
      {
        data: {
          data: [
            {
              ...addedModel,
              description: 'Produces fixed 8192 dimensional embeddings',
              supported_parameters: [],
              dimension: 8192,
              dimensionMode: 'fixed',
              scoreThreshold: 0.9,
            },
          ],
        },
      },
    ]);

    expect((await getKiloEmbeddingModelCatalogFromDatabase())?.models).toEqual([
      { ...addedModel, scoreThreshold: 0.35 },
    ]);
  });

  it('refreshes additions/removals at the TTL and falls back only when the default is removed', async () => {
    store([{ id: KILO_DEFAULT_EMBEDDING_MODEL, name: 'Mistral' }, initialModel]);
    const first = await getKiloEmbeddingModelCatalogFromDatabase();
    store([addedModel]);

    clock.mockReturnValue(START_MS + TTL_MS - 1);
    expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBe(first);
    clock.mockReturnValue(START_MS + TTL_MS);

    expect(await getKiloEmbeddingModelCatalogFromDatabase()).toEqual({
      defaultModel: addedModel.id,
      models: [{ ...addedModel, scoreThreshold: 0.35 }],
      aliases: {},
    });
    expect(mockReadRows).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes fallback additions/removals at the TTL without retaining a removed default or alias', async () => {
    mockReadRows.mockResolvedValue([]);
    fetchSpy.mockResolvedValue(
      upstreamModels([{ id: KILO_DEFAULT_EMBEDDING_MODEL, name: 'Mistral' }, initialModel])
    );
    const first = await getKiloEmbeddingModelCatalogFromDatabase();
    expect(first?.defaultModel).toBe(KILO_DEFAULT_EMBEDDING_MODEL);
    expect(first?.aliases).toEqual({ 'mistral-embed-2312': KILO_DEFAULT_EMBEDDING_MODEL });
    fetchSpy.mockResolvedValue(upstreamModels([addedModel]));

    clock.mockReturnValue(START_MS + TTL_MS - 1);
    expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBe(first);
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(START_MS + TTL_MS);

    expect(await getKiloEmbeddingModelCatalogFromDatabase()).toEqual({
      defaultModel: addedModel.id,
      models: [{ ...addedModel, scoreThreshold: 0.35 }],
      aliases: {},
    });
    expect(mockReadRows).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each(upstreamFailures)(
    'retains the last good catalog on upstream %s failure, backs off, and recovers',
    async kind => {
      const first = await getKiloEmbeddingModelCatalogFromDatabase();
      mockReadRows.mockResolvedValue([]);
      const timeoutSignal = failUpstream(kind);
      clock.mockReturnValue(START_MS + TTL_MS);

      expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBe(first);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      if (timeoutSignal) {
        expect(AbortSignal.timeout).toHaveBeenCalledWith(FETCH_TIMEOUT_MS);
        expect(fetchSpy).toHaveBeenCalledWith(
          openRouterEmbeddingModelsMetadataSource.url,
          expect.objectContaining({ signal: timeoutSignal })
        );
        expect(timeoutSignal.aborted).toBe(true);
      }
      fetchSpy.mockResolvedValue(upstreamModels([addedModel]));
      clock.mockReturnValue(START_MS + TTL_MS + FAILURE_BACKOFF_MS - 1);
      expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBe(first);
      expect(mockReadRows).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(START_MS + TTL_MS + FAILURE_BACKOFF_MS);
      expect((await getKiloEmbeddingModelCatalogFromDatabase())?.defaultModel).toBe(addedModel.id);
      expect(mockReadRows).toHaveBeenCalledTimes(3);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    }
  );

  it.each(upstreamFailures)(
    'returns null for cold upstream %s failure, backs off, and recovers before the full TTL',
    async kind => {
      mockReadRows.mockRejectedValue(new Error('Replica unavailable'));
      const timeoutSignal = failUpstream(kind);

      expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      if (timeoutSignal) {
        expect(AbortSignal.timeout).toHaveBeenCalledWith(FETCH_TIMEOUT_MS);
        expect(fetchSpy).toHaveBeenCalledWith(
          openRouterEmbeddingModelsMetadataSource.url,
          expect.objectContaining({ signal: timeoutSignal })
        );
        expect(timeoutSignal.aborted).toBe(true);
      }
      fetchSpy.mockResolvedValue(upstreamModels([addedModel]));
      clock.mockReturnValue(START_MS + FAILURE_BACKOFF_MS - 1);
      expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBeNull();
      expect(mockReadRows).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(START_MS + FAILURE_BACKOFF_MS);
      expect((await getKiloEmbeddingModelCatalogFromDatabase())?.defaultModel).toBe(addedModel.id);
      expect(mockReadRows).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    }
  );

  it('shares one in-flight refresh among concurrent callers', async () => {
    const pending = Promise.withResolvers<Array<{ data: unknown }>>();
    mockReadRows.mockReturnValue(pending.promise);

    const requests = Array.from({ length: 10 }, () => getKiloEmbeddingModelCatalogFromDatabase());
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    pending.resolve([{ data: { data: [addedModel] } }]);
    const catalogs = await Promise.all(requests);

    expect(catalogs[0]?.defaultModel).toBe(addedModel.id);
    expect(catalogs.every(catalog => catalog === catalogs[0])).toBe(true);
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shares one database read and network fallback among concurrent callers', async () => {
    mockReadRows.mockResolvedValue([]);
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    fetchSpy.mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });

    const requests = Array.from({ length: 10 }, () => getKiloEmbeddingModelCatalogFromDatabase());
    await started.promise;
    requests.push(getKiloEmbeddingModelCatalogFromDatabase());
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    pending.resolve(upstreamModels([addedModel]));
    const catalogs = await Promise.all(requests);

    expect(catalogs[0]?.defaultModel).toBe(addedModel.id);
    expect(catalogs.every(catalog => catalog === catalogs[0])).toBe(true);
    expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBe(catalogs[0]);
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('can reset the reader for a deterministic cold read', async () => {
    await getKiloEmbeddingModelCatalogFromDatabase();
    store([addedModel]);
    resetKiloEmbeddingModelCatalogCache();

    expect((await getKiloEmbeddingModelCatalogFromDatabase())?.defaultModel).toBe(addedModel.id);
    expect(mockReadRows).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { KILO_DEFAULT_EMBEDDING_MODEL } from '@kilocode/web-shared/lib/ai-gateway/embeddings/kilo-embedding-models';
import {
  getKiloEmbeddingModelCatalogFromDatabase,
  openRouterEmbeddingModelsMetadataSource,
  resetKiloEmbeddingModelCatalogCache,
} from '@kilocode/web-shared/lib/ai-gateway/embeddings/openrouter-embedding-models';

const mockReadRows = jest.fn<Promise<Array<{ data: unknown }>>, []>();

// Keep readStoredMetadata real, including parsing and its null-on-error contract. Only replace
// the database boundary so missing, corrupt, and rejected reads are deterministic.
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
const START_MS = 1_000_000;
const initialModel = { id: 'vendor/first-embed', name: 'First Embed' };
const addedModel = { id: 'vendor/new-embed', name: 'New Embed' };
let clock: jest.SpiedFunction<typeof Date.now>;
let fetchSpy: jest.SpiedFunction<typeof fetch>;

function store(models: Array<{ id: string; name: string }>) {
  mockReadRows.mockResolvedValue([{ data: { data: models } }]);
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
  expect(fetchSpy).not.toHaveBeenCalled();
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
  });

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
  });

  it('returns null for a cold missing row and recovers after backoff, not the full TTL', async () => {
    mockReadRows.mockResolvedValue([]);
    expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBeNull();
    store([addedModel]);

    clock.mockReturnValue(START_MS + FAILURE_BACKOFF_MS - 1);
    expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBeNull();
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(START_MS + FAILURE_BACKOFF_MS);

    expect((await getKiloEmbeddingModelCatalogFromDatabase())?.defaultModel).toBe(addedModel.id);
    expect(mockReadRows).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'corrupt', 'error'])(
    'retains the last good catalog on a %s read',
    async kind => {
      const first = await getKiloEmbeddingModelCatalogFromDatabase();
      if (kind === 'missing') mockReadRows.mockResolvedValue([]);
      else if (kind === 'corrupt') mockReadRows.mockResolvedValue([{ data: { data: [] } }]);
      else mockReadRows.mockRejectedValue(new Error('Replica unavailable'));
      clock.mockReturnValue(START_MS + TTL_MS);

      expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBe(first);
      store([addedModel]);
      clock.mockReturnValue(START_MS + TTL_MS + FAILURE_BACKOFF_MS - 1);
      expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBe(first);
      expect(mockReadRows).toHaveBeenCalledTimes(2);

      clock.mockReturnValue(START_MS + TTL_MS + FAILURE_BACKOFF_MS);
      expect((await getKiloEmbeddingModelCatalogFromDatabase())?.defaultModel).toBe(addedModel.id);
      expect(mockReadRows).toHaveBeenCalledTimes(3);
    }
  );

  it.each(['corrupt', 'error'])(
    'returns null on a cold %s read without fetching upstream',
    async kind => {
      if (kind === 'corrupt') mockReadRows.mockResolvedValue([{ data: { invalid: true } }]);
      else mockReadRows.mockRejectedValue(new Error('Replica unavailable'));

      expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBeNull();
      expect(await getKiloEmbeddingModelCatalogFromDatabase()).toBeNull();
      expect(mockReadRows).toHaveBeenCalledTimes(1);
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
  });

  it('can reset the reader for a deterministic cold read', async () => {
    await getKiloEmbeddingModelCatalogFromDatabase();
    store([addedModel]);
    resetKiloEmbeddingModelCatalogCache();

    expect((await getKiloEmbeddingModelCatalogFromDatabase())?.defaultModel).toBe(addedModel.id);
    expect(mockReadRows).toHaveBeenCalledTimes(2);
  });
});

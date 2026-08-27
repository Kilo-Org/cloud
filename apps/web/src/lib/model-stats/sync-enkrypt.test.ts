import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/drizzle';
import { fetchWithBackoff } from '@/lib/fetchWithBackoff';
import { insertTestModelStats } from '@/tests/helpers/model-stats.helper';
import { modelStats } from '@kilocode/db/schema';
import type { ModelStats } from '@kilocode/db/schema';
import type { EnkryptScore } from '@kilocode/db/schema-types';
import { eq, inArray } from 'drizzle-orm';
import { matchEnkryptScores, parseEnkryptScores, syncEnkryptBenchmarks } from './sync-enkrypt';

let mockApiKey: string | undefined = 'dummy-enkrypt-api-key';

jest.mock('@/lib/config.server', () => ({
  get ENKRYPT_API_KEY() {
    return mockApiKey;
  },
}));

jest.mock('@/lib/fetchWithBackoff', () => ({ fetchWithBackoff: jest.fn() }));

const mockFetch = jest.mocked(fetchWithBackoff);

function score(overrides: Partial<EnkryptScore> = {}): EnkryptScore {
  return {
    model_name: 'gpt-4o',
    provider: 'OpenAI',
    source: 'Enkrypt AI',
    risk_score: 0,
    bias_score: null,
    ...overrides,
  };
}

function envelope(scores: unknown[]) {
  return { status: 'success', data: { scores } };
}

function catalogModel(
  openrouterId: string,
  overrides: Partial<Parameters<typeof matchEnkryptScores>[1][number]> = {}
) {
  return {
    id: openrouterId,
    openrouterId,
    isActive: true,
    isStealth: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockApiKey = 'dummy-enkrypt-api-key';
  mockFetch.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('parseEnkryptScores', () => {
  it('preserves raw identities, optional values, zeros and nulls while stripping unknown fields', () => {
    const raw = score({
      model_name: 'openai/gpt-4o:free',
      provider: 'OpenAI',
      source: ' Original source ',
      cbrn_score: 0,
      harmful_score: null,
      insecure_code_score: -1.5,
      toxicity_score: 12.345,
      robustness_score: 100,
      jailbreak_score: 0,
      evasion_score: null,
      safety_score: 7,
      nist_score: null,
      owasp_score: 0,
    });
    const parsed = parseEnkryptScores({
      ...envelope([{ ...raw, apikey: 'dummy-echoed-key', lastUpdated: 'upstream-value' }]),
      secret: 'dummy-envelope-key',
    });

    expect(parsed).toEqual([raw]);
    expect(parsed[0]).not.toHaveProperty('apikey');
    expect(parsed[0]).not.toHaveProperty('lastUpdated');
    expect(parseEnkryptScores(envelope([{ model_name: 'm', provider: 'p', source: 's' }]))).toEqual(
      [{ model_name: 'm', provider: 'p', source: 's' }]
    );
  });

  it.each(
    [
      null,
      [],
      {},
      { status: 'error', data: { scores: [] } },
      { status: 'success' },
      { status: 'success', data: {} },
      { status: 'success', data: { scores: null } },
      envelope([score(), null]),
      envelope([score(), { ...score(), model_name: '' }]),
      envelope([{ ...score(), provider: '' }]),
      envelope([{ ...score(), source: null }]),
      envelope([{ ...score(), risk_score: '0' }]),
      envelope([{ ...score(), safety_score: Number.NaN }]),
      envelope([{ ...score(), bias_score: Number.POSITIVE_INFINITY }]),
    ].map(value => ({ value }))
  )('rejects malformed complete responses without exposing their contents: %#', ({ value }) => {
    expect(() => parseEnkryptScores(value)).toThrow('Invalid Enkrypt scores response');
  });

  it('accepts an explicitly empty scores array', () => {
    expect(parseEnkryptScores(envelope([]))).toEqual([]);
  });
});

describe('matchEnkryptScores', () => {
  it.each([
    ['OpenAI', 'openai'],
    ['Anthropic', 'anthropic'],
    ['Google', 'google'],
    ['Meta', 'meta-llama'],
    ['Mistral AI', 'mistralai'],
    ['DeepSeek', 'deepseek'],
    ['xAI', 'x-ai'],
    ['qwen', 'qwen'],
  ])(
    'matches the explicit provider identity %s to %s without changing the model name',
    (provider, prefix) => {
      const input = score({ model_name: 'model-2026:thinking', provider });
      const model = catalogModel(`${prefix}/model-2026:thinking`);
      const result = matchEnkryptScores(
        [input],
        [model, catalogModel('other/model-2026:thinking')]
      );

      expect(result).toEqual({
        matches: [{ model, score: input }],
        unmatchedModelNames: [],
        ambiguousCount: 0,
      });
    }
  );

  it('matches fully qualified IDs exactly even when the provider describes the serving platform', () => {
    const input = score({ model_name: 'anthropic/claude-test', provider: 'Amazon Bedrock' });
    const model = catalogModel('anthropic/claude-test');
    expect(matchEnkryptScores([input], [model]).matches).toEqual([{ model, score: input }]);
  });

  it.each([
    ['gpt-4o', 'Unknown provider'],
    ['GPT-4o', 'OpenAI'],
    ['gpt-4o-2024-08-06', 'OpenAI'],
    ['gpt-4o:free', 'OpenAI'],
    ['gpt-4o:thinking', 'OpenAI'],
    ['gpt-4o:reasoning', 'OpenAI'],
    ['gpt-4o:exacto', 'OpenAI'],
    ['gpt-4o', 'Anthropic'],
    ['openai/GPT-4o', 'OpenAI'],
    ['gpt-4o ', 'OpenAI'],
    ['gpt-4o', 'Open AI'],
  ])('does not infer variants or provider aliases for %s / %s', (model_name, provider) => {
    expect(
      matchEnkryptScores([score({ model_name, provider })], [catalogModel('openai/gpt-4o')])
    ).toEqual({ matches: [], unmatchedModelNames: [model_name], ambiguousCount: 0 });
  });

  it('keeps dated, colon, free and reasoning variants distinct when they exist', () => {
    const names = ['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o:free', 'gpt-4o:reasoning'];
    const result = matchEnkryptScores(
      names.map(model_name => score({ model_name })),
      names.map(name => catalogModel(`openai/${name}`))
    );
    expect(result.matches.map(match => match.model.openrouterId).sort()).toEqual(
      names.map(name => `openai/${name}`).sort()
    );
    expect(result.ambiguousCount).toBe(0);
  });

  it('rejects inactive, stealth, internal, private, custom and virtual catalog IDs', () => {
    const models = [
      catalogModel('openai/inactive', { isActive: false }),
      catalogModel('openai/null-active', { isActive: null }),
      catalogModel('openai/stealth', { isStealth: true }),
      ...[
        'kilo-internal/custom',
        'kilo-auto/balanced',
        'internal/model',
        'private/model',
        'custom/model',
        'kilo/openai/gpt-4o',
        'kilocode/model',
        'openrouter/auto',
        'unqualified-model',
      ].map(id => catalogModel(id)),
    ];
    const inputs = models.map(model => score({ model_name: model.openrouterId }));
    const result = matchEnkryptScores(inputs, models);
    expect(result.matches).toEqual([]);
    expect(result.unmatchedModelNames).toEqual(models.map(model => model.openrouterId));
  });

  it('skips all duplicate candidates, including identical duplicates and cross-source/provider matches', () => {
    const result = matchEnkryptScores(
      [
        score(),
        score({ model_name: 'openai/gpt-4o', provider: 'Azure', source: 'other' }),
        score({ model_name: 'claude', provider: 'Anthropic' }),
        score({ model_name: 'claude', provider: 'Anthropic' }),
        score({ model_name: 'unique' }),
      ],
      [
        catalogModel('openai/gpt-4o'),
        catalogModel('anthropic/claude'),
        catalogModel('openai/unique'),
      ]
    );
    expect(result.matches.map(match => match.model.openrouterId)).toEqual(['openai/unique']);
    expect(result.ambiguousCount).toBe(4);
    expect(result.unmatchedModelNames).toEqual([]);
  });
});

describe('syncEnkryptBenchmarks database updates', () => {
  const insertedIds: string[] = [];

  async function insertModel(overrides: Partial<ModelStats> = {}) {
    const model = await insertTestModelStats({
      openrouterId: `openai/enkrypt-test-${randomUUID()}`,
      ...overrides,
    });
    insertedIds.push(model.id);
    if (overrides.isStealth) {
      await db.update(modelStats).set({ isStealth: true }).where(eq(modelStats.id, model.id));
    }
    return model;
  }

  async function readModel(id: string) {
    const [model] = await db.select().from(modelStats).where(eq(modelStats.id, id));
    return model;
  }

  async function insertLastGoodModel() {
    return insertModel({
      benchmarks: {
        artificialAnalysis: { codingIndex: 42 },
        kiloBench: { overallScore: 0.5, evals: {} },
        enkrypt: { ...score(), lastUpdated: '2026-01-01T00:00:00.000Z' },
      },
    });
  }

  afterEach(async () => {
    if (insertedIds.length > 0) {
      await db.delete(modelStats).where(inArray(modelStats.id, insertedIds));
      insertedIds.length = 0;
    }
  });

  it('merges only the Enkrypt snapshot, preserves siblings and raw values, and never persists the key', async () => {
    const model = await insertLastGoodModel();
    const input = score({
      model_name: model.openrouterId,
      provider: 'OpenAI',
      source: ' Source spelling ',
      risk_score: 0,
      bias_score: null,
      cbrn_score: 0,
      harmful_score: null,
      insecure_code_score: 12.5,
      toxicity_score: 0,
      robustness_score: null,
      jailbreak_score: 0,
      evasion_score: null,
      safety_score: 100,
      nist_score: 0,
      owasp_score: null,
    });
    mockFetch.mockResolvedValue(
      Response.json(envelope([{ ...input, apikey: mockApiKey, lastUpdated: 'untrusted' }]))
    );
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const before = Date.now();
    const result = await syncEnkryptBenchmarks();
    const stored = await readModel(model.id);

    expect(result).toEqual({
      fetchedCount: 1,
      matchedCount: 1,
      unmatchedCount: 0,
      ambiguousCount: 0,
      updatedCount: 1,
      unmatchedModelNames: [],
    });
    expect(stored.benchmarks).toEqual({
      artificialAnalysis: model.benchmarks?.artificialAnalysis,
      kiloBench: model.benchmarks?.kiloBench,
      enkrypt: { ...input, lastUpdated: expect.any(String) },
    });
    const lastUpdated = stored.benchmarks?.enkrypt?.lastUpdated;
    expect(lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(lastUpdated ?? '')).toBeGreaterThanOrEqual(before);
    expect(Date.parse(lastUpdated ?? '')).toBeLessThanOrEqual(Date.now());
    expect(JSON.stringify(stored)).not.toContain('dummy-enkrypt-api-key');
    expect(stored.openrouterData).toEqual(model.openrouterData);
    expect(stored.benchmarks?.enkrypt).not.toHaveProperty('apikey');

    const [url, init, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.enkryptai.com/leaderboard/v2/scores');
    expect(init).toEqual({
      method: 'GET',
      headers: { apikey: 'dummy-enkrypt-api-key' },
      signal: expect.any(AbortSignal),
      redirect: 'error',
      cache: 'no-store',
    });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(options).toMatchObject({ baseDelayMs: 1_000, maxDelayMs: 10_000 });
    for (const status of [429, 500, 502, 503]) {
      expect(options?.retryResponse?.(new Response(null, { status }))).toBe(true);
    }
    for (const status of [200, 301, 400, 401, 403, 404]) {
      expect(options?.retryResponse?.(new Response(null, { status }))).toBe(false);
    }
  });

  it('fills a null JSONB value without inventing optional scores or placeholder models', async () => {
    const model = await insertModel();
    const input = { model_name: model.openrouterId, provider: 'openai', source: 'Enkrypt' };
    mockFetch.mockResolvedValue(Response.json(envelope([input])));
    expect(await syncEnkryptBenchmarks()).toMatchObject({ matchedCount: 1, updatedCount: 1 });
    expect((await readModel(model.id)).benchmarks).toEqual({
      enkrypt: { ...input, lastUpdated: expect.any(String) },
    });
  });

  it('reports skipped duplicates and unmapped scores without altering their last good rows', async () => {
    const conflicting = await insertLastGoodModel();
    const unique = await insertModel();
    const missing = `missing-${randomUUID()}`;
    mockFetch.mockResolvedValue(
      Response.json(
        envelope([
          score({ model_name: conflicting.openrouterId }),
          score({ model_name: conflicting.openrouterId.split('/')[1], source: 'Other' }),
          score({ model_name: unique.openrouterId }),
          score({ model_name: missing }),
        ])
      )
    );

    expect(await syncEnkryptBenchmarks()).toEqual({
      fetchedCount: 4,
      matchedCount: 1,
      unmatchedCount: 1,
      ambiguousCount: 2,
      updatedCount: 1,
      unmatchedModelNames: [missing],
    });
    expect(await readModel(conflicting.id)).toEqual(conflicting);
    expect((await readModel(unique.id)).benchmarks?.enkrypt).toBeDefined();
    expect(
      await db
        .select()
        .from(modelStats)
        .where(eq(modelStats.openrouterId, `openai/${missing}`))
    ).toEqual([]);
  });

  it('updates only exact public active variants and the correct provider', async () => {
    const name = `enkrypt-test-${randomUUID()}`;
    const models = await Promise.all([
      insertModel({ openrouterId: `openai/${name}` }),
      insertModel({ openrouterId: `anthropic/${name}` }),
      insertModel({ openrouterId: `openai/${name}:free` }),
      insertModel({ openrouterId: `openai/${name}:reasoning` }),
      insertModel({ openrouterId: `openai/${name}-2026-01-01` }),
      insertModel({ openrouterId: `openai/${name}-inactive`, isActive: false }),
      insertModel({ openrouterId: `openai/${name}-stealth`, isStealth: true }),
      insertModel({ openrouterId: `kilo-internal/${name}` }),
      insertModel({ openrouterId: `private/${name}` }),
      insertModel({ openrouterId: `custom/${name}` }),
    ]);
    mockFetch.mockResolvedValue(
      Response.json(
        envelope([
          score({ model_name: name }),
          ...models.slice(5).map(model => score({ model_name: model.openrouterId })),
        ])
      )
    );

    expect(await syncEnkryptBenchmarks()).toMatchObject({
      fetchedCount: 6,
      matchedCount: 1,
      unmatchedCount: 5,
      updatedCount: 1,
    });
    for (const [index, model] of models.entries()) {
      expect((await readModel(model.id)).benchmarks?.enkrypt !== undefined).toBe(index === 0);
    }
  });

  it('preserves a newer snapshot when an older ingestion reaches the update', async () => {
    const existing = { ...score(), lastUpdated: '9999-01-01T00:00:00.000Z' };
    const model = await insertModel({ benchmarks: { enkrypt: existing } });
    mockFetch.mockResolvedValue(
      Response.json(envelope([score({ model_name: model.openrouterId })]))
    );

    expect(await syncEnkryptBenchmarks()).toMatchObject({ matchedCount: 1, updatedCount: 0 });
    expect(await readModel(model.id)).toEqual(model);
  });

  it('rolls back all matched writes when the transaction fails', async () => {
    const models = await Promise.all([insertLastGoodModel(), insertLastGoodModel()]);
    mockFetch.mockResolvedValue(
      Response.json(envelope(models.map(model => score({ model_name: model.openrouterId }))))
    );
    const transaction = db.transaction.bind(db);
    jest.spyOn(db, 'transaction').mockImplementation(callback =>
      transaction(async tx => {
        await callback(tx);
        throw new Error('Simulated transaction failure');
      })
    );

    await expect(syncEnkryptBenchmarks()).rejects.toThrow('Simulated transaction failure');
    for (const model of models) expect(await readModel(model.id)).toEqual(model);
  });

  it.each([undefined, '', '   '])(
    'throws safely for a missing key (%#) before fetching or writing',
    async key => {
      const model = await insertLastGoodModel();
      mockApiKey = key;
      const transaction = jest.spyOn(db, 'transaction');

      await expect(syncEnkryptBenchmarks()).rejects.toThrow('ENKRYPT_API_KEY is not configured');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(await readModel(model.id)).toEqual(model);
    }
  );

  it.each([301, 401, 403, 429, 500, 503])(
    'exposes only HTTP status %s and retains last good data',
    async status => {
      const model = await insertLastGoodModel();
      const response = new Response('dummy-secret-body', {
        status,
        statusText: 'dummy-secret-status-text',
        headers: { 'x-secret': 'dummy-secret-header' },
      });
      const json = jest.spyOn(response, 'json');
      const text = jest.spyOn(response, 'text');
      mockFetch.mockResolvedValue(response);
      const transaction = jest.spyOn(db, 'transaction');

      await expect(syncEnkryptBenchmarks()).rejects.toEqual(
        new Error(`Enkrypt scores request failed (HTTP ${status})`)
      );
      expect(json).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(await readModel(model.id)).toEqual(model);
    }
  );

  it('sanitizes network errors and does not write', async () => {
    const model = await insertLastGoodModel();
    mockFetch.mockRejectedValue(new Error('dummy-enkrypt-api-key and request init'));
    const transaction = jest.spyOn(db, 'transaction');

    await expect(syncEnkryptBenchmarks()).rejects.toEqual(
      new Error('Enkrypt scores request failed')
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(await readModel(model.id)).toEqual(model);
  });

  it.each(['invalid-json', 'invalid-envelope', 'invalid-later-score'])(
    'rejects %s before any writes',
    async failure => {
      const model = await insertLastGoodModel();
      const valid = score({ model_name: model.openrouterId });
      const response =
        failure === 'invalid-json'
          ? new Response('dummy-enkrypt-api-key is not JSON')
          : Response.json(
              failure === 'invalid-envelope'
                ? { status: 'failed', data: { scores: [valid] } }
                : envelope([valid, { ...valid, risk_score: 'dummy-enkrypt-api-key' }])
            );
      mockFetch.mockResolvedValue(response);
      const transaction = jest.spyOn(db, 'transaction');

      await expect(syncEnkryptBenchmarks()).rejects.toEqual(
        new Error('Invalid Enkrypt scores response')
      );
      expect(transaction).not.toHaveBeenCalled();
      expect(await readModel(model.id)).toEqual(model);
    }
  );

  it.each([
    { scores: [] },
    { scores: [score({ model_name: 'unmapped-model', provider: 'Unknown' })] },
  ])('preserves last good data for empty or unmapped responses: %#', async ({ scores }) => {
    const model = await insertLastGoodModel();
    mockFetch.mockResolvedValue(Response.json(envelope(scores)));
    const transaction = jest.spyOn(db, 'transaction');

    expect(await syncEnkryptBenchmarks()).toEqual({
      fetchedCount: scores.length,
      matchedCount: 0,
      unmatchedCount: scores.length,
      ambiguousCount: 0,
      updatedCount: 0,
      unmatchedModelNames: scores.map(input => input.model_name),
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(await readModel(model.id)).toEqual(model);
  });
});

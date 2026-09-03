import { DirectUserByokInferenceProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { db } from '@/lib/drizzle';
import { redisClient } from '@/lib/redis';
import { directByokModelsRedisKey } from '@/lib/redis-keys';
import { direct_byok_model_lists } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { DirectByokModel } from './types';
import {
  parseModelsDevProviderModels,
  parseOpenAICompatibleProviderModels,
  syncDirectByokModels,
} from './sync-direct-byok';

jest.mock('@/lib/redis', () => ({
  redisClient: { set: jest.fn() },
}));

describe('parseOpenAICompatibleProviderModels', () => {
  test('parses Morph OpenAI-compatible model metadata', () => {
    const models = parseOpenAICompatibleProviderModels({
      data: [
        {
          id: 'morph-qwen35-397b',
          name: 'Morph: Qwen 3.5 397B',
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
          context_length: 262144,
          max_output_length: 131072,
          supported_features: ['tools', 'json_mode'],
        },
        {
          id: 'morph-minimax3-428b',
          max_model_len: 256000,
        },
        {
          id: 'provider-with-null-context',
          context_length: null,
        },
      ],
    });

    expect(models).toEqual([
      {
        id: 'morph-qwen35-397b',
        name: 'Morph: Qwen 3.5 397B',
        context_length: 262144,
        max_completion_tokens: 131072,
        input_modalities: ['text', 'image'],
        flags: ['reasoning'],
      },
      {
        id: 'morph-minimax3-428b',
        name: undefined,
        context_length: 256000,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: ['reasoning'],
      },
      {
        id: 'provider-with-null-context',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: ['reasoning'],
      },
    ]);
  });

  test('excludes models with supported features that do not include tools', () => {
    const models = parseOpenAICompatibleProviderModels({
      data: [
        { id: 'without-supported-features' },
        { id: 'supports-tools', supported_features: ['tools', 'json_mode'] },
        { id: 'unsupported-tools', supported_features: ['json_mode'] },
        { id: 'empty-supported-features', supported_features: [] },
      ],
    });

    expect(models.map(model => model.id)).toEqual(['without-supported-features', 'supports-tools']);
  });
});

describe('parseModelsDevProviderModels', () => {
  test('excludes deprecated and non-text-output models while retaining other statuses', () => {
    const models = parseModelsDevProviderModels(
      {
        models: {
          stable: {
            id: 'stable',
            name: 'provider/stable',
            reasoning: true,
            reasoning_options: [
              { type: 'toggle' },
              { type: 'effort', values: ['high', 'max', 'default', null] },
            ],
            limit: { context: 128_000, output: 32_000 },
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
          alpha: {
            id: 'alpha',
            status: 'alpha',
            reasoning: true,
            reasoning_options: [{ type: 'toggle' }],
          },
          beta: {
            id: 'claude-beta',
            status: 'beta',
            reasoning: false,
          },
          unknownStatus: {
            id: 'unknown-status',
            status: 'active',
          },
          deprecated: {
            id: 'mimo-v2-omni',
            name: 'MiMo V2 Omni',
            status: 'deprecated',
          },
          imageOnly: {
            id: 'wan2.7-image',
            name: 'Wan2.7 Image',
            modalities: { input: ['text'], output: ['image'] },
          },
        },
      },
      'alibaba-token-plan'
    );

    expect(models).toEqual([
      {
        id: 'stable',
        name: 'stable',
        context_length: 128_000,
        max_completion_tokens: 32_000,
        input_modalities: ['text', 'image'],
        flags: ['reasoning'],
        variants: {
          none: { reasoning: { enabled: false, effort: 'none' } },
          high: { reasoning: { enabled: true, effort: 'high' } },
          max: { reasoning: { enabled: true, effort: 'max' } },
        },
      },
      {
        id: 'alpha',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: ['reasoning'],
        variants: {
          instant: { reasoning: { enabled: false, effort: 'none' } },
          thinking: { reasoning: { enabled: true, effort: 'high' } },
        },
      },
      {
        id: 'claude-beta',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: undefined,
        variants: undefined,
      },
      {
        id: 'unknown-status',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: undefined,
        variants: undefined,
      },
    ]);
  });

  test('ignores reasoning option types that are not supported locally', () => {
    const models = parseModelsDevProviderModels(
      {
        models: {
          futureControl: {
            id: 'future-control',
            reasoning: true,
            reasoning_options: [{ type: 'budget_tokens', min: 0, max: 32_000 }],
          },
        },
      },
      'alibaba-token-plan'
    );

    expect(models[0]).toMatchObject({
      id: 'future-control',
      flags: ['reasoning'],
    });
    expect(models[0].variants).toBeUndefined();
  });

  test('sets verbosity from effort for Anthropic-backed models', () => {
    const models = parseModelsDevProviderModels(
      {
        models: {
          qwen: {
            id: 'qwen-test',
            reasoning: true,
            reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }],
          },
        },
      },
      'opencode-go'
    );

    expect(models[0].variants).toEqual({
      none: { reasoning: { enabled: false, effort: 'none' } },
      low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
      high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
    });
  });

  test('sets verbosity on fallback variants for Anthropic-backed models', () => {
    const models = parseModelsDevProviderModels(
      {
        models: {
          qwen: {
            id: 'qwen-test',
            reasoning: true,
            reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', max: 32_000 }],
          },
        },
      },
      'opencode-go'
    );

    expect(models[0].variants).toEqual({
      minimal: { reasoning: { enabled: true, effort: 'minimal' } },
      low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
      medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
      high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
      xhigh: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'xhigh' },
    });
  });

  test('excludes models missing from the provider model list', () => {
    const models = parseModelsDevProviderModels(
      {
        models: {
          available: { id: 'available', limit: { context: 128_000 } },
          removed: { id: 'removed', limit: { context: 64_000 } },
        },
      },
      'alibaba-token-plan',
      new Set(['available', 'provider-only'])
    );

    expect(models.map(model => model.id)).toEqual(['available']);
    expect(models[0].context_length).toBe(128_000);
  });

  test('excludes explicit capability mismatches while accepting missing metadata', () => {
    const model = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      name: id,
      tool_call: true,
      modalities: { input: ['text'], output: ['text'] },
      ...overrides,
    });
    const models = parseModelsDevProviderModels(
      {
        models: {
          chat: model('nvidia/chat', {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['none', 'high', 'max'] }],
            limit: { context: 128000 },
          }),
          vision: model('nvidia/vision', {
            modalities: { input: ['text', 'image'], output: ['text'] },
          }),
          unknownCapabilities: { id: 'nvidia/unknown' },
          unavailable: model('nvidia/unavailable'),
          noTools: model('nvidia/no-tools', { tool_call: false }),
          noTextInput: model('nvidia/no-text-input', {
            modalities: { input: ['image'], output: ['text'] },
          }),
        },
      },
      'nvidia-byok',
      new Set([
        'nvidia/chat',
        'nvidia/vision',
        'nvidia/unknown',
        'nvidia/no-tools',
        'nvidia/no-text-input',
      ])
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: 'nvidia/chat',
        context_length: 128000,
        flags: ['reasoning'],
        variants: {
          none: { reasoning: { enabled: false, effort: 'none' } },
          high: { reasoning: { enabled: true, effort: 'high' } },
          max: { reasoning: { enabled: true, effort: 'max' } },
        },
      }),
      expect.objectContaining({
        id: 'nvidia/vision',
        input_modalities: ['text', 'image'],
      }),
      expect.objectContaining({ id: 'nvidia/unknown' }),
    ]);
  });
});

describe('syncDirectByokModels database snapshots', () => {
  const providerId = 'nvidia-byok';
  const providerKey = directByokModelsRedisKey(providerId);
  const redisSet = jest.mocked(redisClient.set);
  const oldSyncedAt = '2020-01-02T03:04:05.000Z';
  const downloadedModels = {
    reasoner: {
      id: 'nvidia/reasoner',
      name: 'NVIDIA / Vision Reasoner ',
      reasoning: true,
      reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['high', 'max'] }],
      limit: { context: 16_000, output: 64_000 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      tool_call: true,
    },
    defaults: { id: 'nvidia/defaults' },
    unsupported: { id: 'nvidia/no-tools', tool_call: false },
  };
  const normalizedModels: DirectByokModel[] = [
    {
      id: 'nvidia/reasoner',
      name: 'Vision Reasoner',
      flags: ['reasoning', 'vision'],
      context_length: 16_000,
      max_completion_tokens: 16_000,
      variants: {
        none: { reasoning: { enabled: false, effort: 'none' } },
        high: { reasoning: { enabled: true, effort: 'high' } },
        max: { reasoning: { enabled: true, effort: 'max' } },
      },
    },
    {
      id: 'nvidia/defaults',
      name: 'defaults',
      context_length: 200_000,
      max_completion_tokens: 32_000,
    },
  ];
  let providerModels: Record<string, { id: string } & Record<string, unknown>>;
  let fetchAvailableModels: () => Promise<Response>;

  beforeEach(async () => {
    await db
      .delete(direct_byok_model_lists)
      .where(
        inArray(
          direct_byok_model_lists.provider_id,
          DirectUserByokInferenceProviderIdSchema.options
        )
      );
    redisSet.mockReset().mockResolvedValue('OK');
    providerModels = downloadedModels;
    fetchAvailableModels = async () =>
      Response.json({ data: Object.values(providerModels).map(({ id }) => ({ id })) });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input === 'https://models.dev/api.json') {
        return Response.json({
          nvidia: { models: providerModels },
          'alibaba-token-plan': { models: {} },
          edenai: { models: {} },
          'zai-coding-plan': { models: {} },
          'ollama-cloud': { models: {} },
          'opencode-go': { models: {} },
          'xiaomi-token-plan-ams': { models: {} },
          'xiaomi-token-plan-sgp': { models: {} },
        });
      }
      if (input === 'https://integrate.api.nvidia.com/v1/models') {
        return fetchAvailableModels();
      }
      return Response.json({ data: [] });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function readSnapshot() {
    const rows = await db
      .select()
      .from(direct_byok_model_lists)
      .where(eq(direct_byok_model_lists.provider_id, providerId));
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function backdateSnapshot() {
    await db
      .update(direct_byok_model_lists)
      .set({ synced_at: oldSyncedAt })
      .where(eq(direct_byok_model_lists.provider_id, providerId));
  }

  function expectCachedModels(models: DirectByokModel[]) {
    const cachedModels = redisSet.mock.calls.find(([key]) => key === providerKey)?.[1];
    if (typeof cachedModels !== 'string') {
      throw new Error('Expected a Redis SET with a serialized model list');
    }
    expect(JSON.parse(cachedModels)).toStrictEqual(models);
  }

  function waitForOtherProviderWrites(redisError?: Error) {
    const pendingKeys = new Set(
      redisSet.mock.calls.map(([key]) => key).filter(key => key !== providerKey)
    );
    const completed = Promise.withResolvers<void>();
    redisSet.mockClear();
    redisSet.mockImplementation(async key => {
      if (key === providerKey) {
        await completed.promise;
        if (redisError) throw redisError;
      } else {
        pendingKeys.delete(key);
        if (pendingKeys.size === 0) completed.resolve();
      }
      return 'OK';
    });
    if (pendingKeys.size === 0) completed.resolve();
    return completed.promise;
  }

  test('persists the normalized download, defaults, and nested variants in PostgreSQL and Redis', async () => {
    const startedAt = Date.now();
    const counts = await syncDirectByokModels();
    const snapshot = await readSnapshot();

    expect(snapshot.models).toStrictEqual(normalizedModels);
    expect(Date.parse(snapshot.synced_at)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(snapshot.synced_at)).toBeLessThanOrEqual(Date.now());
    expect(counts[providerId]).toBe(normalizedModels.length);
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(
      normalizedModels.length
    );
    expectCachedModels(normalizedModels);

    const snapshots = await db.select().from(direct_byok_model_lists);
    expect(snapshots.map(row => row.provider_id).sort()).toEqual(Object.keys(counts).sort());
    expect(snapshots.filter(row => row.provider_id !== providerId).map(row => row.models)).toEqual(
      Object.keys(counts)
        .filter(id => id !== providerId)
        .map(() => [])
    );
  });

  test('re-sync replaces models and metadata, removes stale models, and refreshes synced_at', async () => {
    await syncDirectByokModels();
    await backdateSnapshot();
    providerModels = {
      reasoner: {
        id: 'nvidia/reasoner',
        name: 'NVIDIA/Updated Reasoner',
        reasoning: false,
        limit: { context: 128_000, output: 64_000 },
      },
    };
    redisSet.mockClear();
    const startedAt = Date.now();

    const counts = await syncDirectByokModels();
    const snapshot = await readSnapshot();

    expect(snapshot.models).toStrictEqual([
      {
        id: 'nvidia/reasoner',
        name: 'Updated Reasoner',
        context_length: 128_000,
        max_completion_tokens: 64_000,
      },
    ]);
    expect(new Date(snapshot.synced_at).toISOString()).not.toBe(oldSyncedAt);
    expect(Date.parse(snapshot.synced_at)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(snapshot.synced_at)).toBeLessThanOrEqual(Date.now());
    expect(counts[providerId]).toBe(1);
    expectCachedModels(snapshot.models);
  });

  test('persists a successful empty list over the previous snapshot', async () => {
    await syncDirectByokModels();
    await backdateSnapshot();
    fetchAvailableModels = async () => Response.json({ data: [] });
    redisSet.mockClear();

    const counts = await syncDirectByokModels();
    const snapshot = await readSnapshot();

    expect(snapshot.models).toStrictEqual([]);
    expect(new Date(snapshot.synced_at).toISOString()).not.toBe(oldSyncedAt);
    expect(counts[providerId]).toBe(0);
    expect(redisSet).toHaveBeenCalledWith(providerKey, '[]');
  });

  test('rejects an upstream failure without replacing the last successful snapshot', async () => {
    await syncDirectByokModels();
    await backdateSnapshot();
    const previousSnapshot = await readSnapshot();
    const otherProvidersWritten = waitForOtherProviderWrites();
    fetchAvailableModels = async () => {
      await otherProvidersWritten;
      return new Response(null, { status: 503, statusText: 'Service Unavailable' });
    };

    await expect(syncDirectByokModels()).rejects.toThrow(
      'Failed to fetch nvidia-byok available models: 503 Service Unavailable'
    );

    expect(await readSnapshot()).toStrictEqual(previousSnapshot);
    expect(redisSet.mock.calls.some(([key]) => key === providerKey)).toBe(false);
  });

  test('retains the database write when the subsequent Redis write fails', async () => {
    providerModels = {};
    await syncDirectByokModels();
    const redisError = new Error('Redis unavailable');
    const otherProvidersWritten = waitForOtherProviderWrites(redisError);
    providerModels = downloadedModels;

    await expect(syncDirectByokModels()).rejects.toThrow(redisError);
    await otherProvidersWritten;

    expect((await readSnapshot()).models).toStrictEqual(normalizedModels);
    expectCachedModels(normalizedModels);
  });
});

import { DirectUserByokInferenceProviderIdSchema } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { direct_byok_model_lists } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { DirectByokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import {
  parseAwsBedrockModelsDevModels,
  parseGcpVertexModelsDevModels,
  parseModelsDevProviderModels,
  parseOpenAICompatibleProviderModels,
  syncDirectByokModels,
} from './sync-direct-byok';

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
        reasoning_options: [
          { type: 'toggle' },
          { type: 'effort', values: ['high', 'max', 'default', null] },
        ],
      },
      {
        id: 'alpha',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: ['reasoning'],
        reasoning_options: [{ type: 'toggle' }],
      },
      {
        id: 'claude-beta',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: undefined,
        reasoning_options: undefined,
      },
      {
        id: 'unknown-status',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: undefined,
        reasoning_options: undefined,
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
    expect(models[0].reasoning_options).toBeUndefined();
  });

  test('leaves reasoning options without sendable controls to the model-name fallback', () => {
    const models = parseModelsDevProviderModels(
      {
        models: {
          alwaysOn: { id: 'always-on', reasoning: true, reasoning_options: [] },
          defaultOnly: {
            id: 'default-only',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['default', null] }],
          },
        },
      },
      'alibaba-token-plan'
    );

    expect(models.map(model => model.reasoning_options)).toEqual([undefined, undefined]);
    expect(models.map(model => model.flags)).toEqual([['reasoning'], ['reasoning']]);
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
        reasoning_options: [{ type: 'effort', values: ['none', 'high', 'max'] }],
      }),
      expect.objectContaining({
        id: 'nvidia/vision',
        input_modalities: ['text', 'image'],
      }),
      expect.objectContaining({ id: 'nvidia/unknown' }),
    ]);
  });

  test('excludes models served only over the native Gemini API', () => {
    const models = parseModelsDevProviderModels(
      {
        models: {
          'glm-5.3': {
            id: 'glm-5.3',
            provider: { api: 'https://opencode.ai/inference/go/openai/v1' },
          },
          'qwen3.7-plus': {
            id: 'qwen3.7-plus',
            provider: {
              npm: '@ai-sdk/anthropic',
              api: 'https://opencode.ai/inference/go/anthropic/v1',
            },
          },
          'gpt-6-luna': {
            id: 'gpt-6-luna',
            provider: { npm: '@ai-sdk/openai', api: 'https://opencode.ai/inference/go/openai/v1' },
          },
          'compatible-model': {
            id: 'compatible-model',
            provider: { npm: '@ai-sdk/openai-compatible' },
          },
          'gemini-4-argon-contributor': {
            id: 'gemini-4-argon-contributor',
            provider: {
              npm: '@ai-sdk/google',
              api: 'https://opencode.ai/inference/go/google/v1beta',
            },
          },
          'vertex-gemini': {
            id: 'vertex-gemini',
            provider: { npm: '@ai-sdk/google-vertex' },
          },
          'mistral-alias': {
            id: 'mistral-alias',
            provider: { npm: '@ai-sdk/mistral', api: 'https://opencode.ai/inference/openai/v1' },
          },
          'openrouter-alias': {
            id: 'openrouter-alias',
            provider: { npm: '@openrouter/ai-sdk-provider' },
          },
        },
      },
      'opencode-go',
      new Set([
        'glm-5.3',
        'qwen3.7-plus',
        'gpt-6-luna',
        'compatible-model',
        'gemini-4-argon-contributor',
        'vertex-gemini',
        'mistral-alias',
        'openrouter-alias',
      ])
    );

    expect(models.map(model => model.id)).toEqual([
      'glm-5.3',
      'qwen3.7-plus',
      'gpt-6-luna',
      'compatible-model',
      'mistral-alias',
      'openrouter-alias',
    ]);
  });
});

describe('parseAwsBedrockModelsDevModels', () => {
  const mantle = (path: string) => ({
    npm: '@ai-sdk/amazon-bedrock/mantle',
    api: `https://bedrock-mantle.\${AWS_REGION}.api.aws${path}`,
  });
  const models = {
    'anthropic.claude-sonnet-4-6': { id: 'anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    'global.anthropic.claude-sonnet-4-6': {
      id: 'global.anthropic.claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6 (Global)',
    },
    'us.anthropic.claude-sonnet-4-6': { id: 'us.anthropic.claude-sonnet-4-6' },
    'zai.glm-5': { id: 'zai.glm-5', name: 'GLM-5' },
    'openai.gpt-5.5': { id: 'openai.gpt-5.5', provider: mantle('/openai/v1') },
    'openai.gpt-6-sol': { id: 'openai.gpt-6-sol', provider: mantle('/openai/v1') },
    'global.openai.gpt-6-sol': { id: 'global.openai.gpt-6-sol' },
    'openai.gpt-oss-120b': { id: 'openai.gpt-oss-120b', provider: mantle('/v1') },
    'xai.grok-4.6': { id: 'xai.grok-4.6', provider: mantle('/openai/v1') },
    'global.xai.grok-4.6': { id: 'global.xai.grok-4.6', name: 'Grok 4.6 (Global)' },
    'amazon.nova-pro-v1:0': { id: 'amazon.nova-pro-v1:0' },
    'meta.llama3-1-70b-instruct-v1:0': {
      id: 'meta.llama3-1-70b-instruct-v1:0',
      status: 'deprecated',
    },
  };

  test('selects one endpoint per model and skips Converse-only and deprecated models', () => {
    expect(
      parseAwsBedrockModelsDevModels({ models }).map(({ id, endpoint }) => ({ id, endpoint }))
    ).toEqual([
      { id: 'global.anthropic.claude-sonnet-4-6', endpoint: 'runtime-anthropic' },
      { id: 'zai.glm-5', endpoint: 'runtime-openai' },
      { id: 'openai.gpt-5.5', endpoint: 'mantle-openai' },
      { id: 'openai.gpt-6-sol', endpoint: 'mantle-openai' },
      { id: 'openai.gpt-oss-120b', endpoint: 'mantle-v1' },
      { id: 'global.xai.grok-4.6', endpoint: 'runtime-openai' },
    ]);
  });
});

describe('parseGcpVertexModelsDevModels', () => {
  test('routes Gemini and managed models to Chat Completions and Claude to Messages', () => {
    const models = {
      'gemini-3.5-flash': { id: 'gemini-3.5-flash' },
      'zai-org/glm-5.2-maas': {
        id: 'zai-org/glm-5.2-maas',
        provider: { npm: '@ai-sdk/openai-compatible' },
      },
      'claude-sonnet-4-6@default': {
        id: 'claude-sonnet-4-6@default',
        provider: { npm: '@ai-sdk/google-vertex/anthropic' },
      },
      'mistral-medium-3': { id: 'mistral-medium-3', provider: { npm: '@ai-sdk/mistral' } },
      'gemini-embedding-001': { id: 'gemini-embedding-001', tool_call: false },
    };

    expect(
      parseGcpVertexModelsDevModels({ models }).map(({ id, endpoint }) => ({ id, endpoint }))
    ).toEqual([
      { id: 'gemini-3.5-flash', endpoint: 'openapi' },
      { id: 'zai-org/glm-5.2-maas', endpoint: 'openapi' },
      { id: 'claude-sonnet-4-6@default', endpoint: 'anthropic' },
    ]);
  });
});

describe('syncDirectByokModels database snapshots', () => {
  const providerId = 'nvidia-byok';
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
      reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['high', 'max'] }],
    },
    {
      id: 'nvidia/defaults',
      name: 'defaults',
      context_length: 200_000,
      max_completion_tokens: 32_000,
    },
  ];
  let providerModels: Record<string, { id: string } & Record<string, unknown>>;
  let openCodeGoModels: Record<string, { id: string } & Record<string, unknown>>;
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
    providerModels = downloadedModels;
    openCodeGoModels = {};
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
          'opencode-go': { models: openCodeGoModels },
          'xiaomi-token-plan-ams': { models: {} },
          'xiaomi-token-plan-sgp': { models: {} },
          'amazon-bedrock': { models: {} },
          'google-vertex': { models: {} },
        });
      }
      if (input === 'https://integrate.api.nvidia.com/v1/models') {
        return fetchAvailableModels();
      }
      if (input === 'https://opencode.ai/zen/go/v1/models') {
        return Response.json({ data: Object.values(openCodeGoModels).map(({ id }) => ({ id })) });
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

  test('persists the normalized download, defaults, and reasoning options in PostgreSQL', async () => {
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
  });

  test('persists a successful empty list over the previous snapshot', async () => {
    await syncDirectByokModels();
    await backdateSnapshot();
    fetchAvailableModels = async () => Response.json({ data: [] });
    const counts = await syncDirectByokModels();
    const snapshot = await readSnapshot();

    expect(snapshot.models).toStrictEqual([]);
    expect(new Date(snapshot.synced_at).toISOString()).not.toBe(oldSyncedAt);
    expect(counts[providerId]).toBe(0);
  });

  test('re-sync removes previously synced OpenCode Go models served only over the Gemini API', async () => {
    await db.insert(direct_byok_model_lists).values({
      provider_id: 'opencode-go',
      models: [
        {
          id: 'gemini-4-argon-contributor',
          name: 'Gemini 4 Argon Contributor',
          context_length: 1_048_576,
          max_completion_tokens: 65_536,
        },
      ],
      synced_at: oldSyncedAt,
    });
    openCodeGoModels = {
      'glm-5.3': { id: 'glm-5.3', name: 'GLM-5.3' },
      'gemini-4-argon-contributor': {
        id: 'gemini-4-argon-contributor',
        name: 'Gemini 4 Argon Contributor',
        provider: { npm: '@ai-sdk/google', api: 'https://opencode.ai/inference/go/google/v1beta' },
      },
    };

    const counts = await syncDirectByokModels();
    const [snapshot] = await db
      .select()
      .from(direct_byok_model_lists)
      .where(eq(direct_byok_model_lists.provider_id, 'opencode-go'));

    expect(snapshot.models).toStrictEqual([
      { id: 'glm-5.3', name: 'GLM-5.3', context_length: 200_000, max_completion_tokens: 32_000 },
    ]);
    expect(counts['opencode-go']).toBe(1);
  });

  test('rejects an upstream failure without replacing the last successful snapshot', async () => {
    await syncDirectByokModels();
    await backdateSnapshot();
    const previousSnapshot = await readSnapshot();
    fetchAvailableModels = async () => {
      return new Response(null, { status: 503, statusText: 'Service Unavailable' });
    };

    await expect(syncDirectByokModels()).rejects.toThrow(
      'Failed to fetch nvidia-byok available models: 503 Service Unavailable'
    );

    expect(await readSnapshot()).toStrictEqual(previousSnapshot);
  });
});

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type {
  NormalizedOpenRouterResponse,
  OpenRouterModel,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import type * as ProviderIndex from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

jest.mock('@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server', () => ({
  ...jest.requireActual<typeof ProviderIndex>(
    '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server'
  ),
  fetchLatestModelsByProviderSnapshotFromDb: jest.fn(),
}));

const model: OpenRouterModel = {
  slug: 'provider/model',
  name: 'Model',
  author: 'provider',
  description: '',
  context_length: 1000,
  input_modalities: ['text'],
  output_modalities: ['text'],
  group: 'other',
  updated_at: '2026-09-24T00:00:00Z',
  endpoint: null,
};
const snapshot: NormalizedOpenRouterResponse = {
  providers: [
    {
      name: 'Provider',
      displayName: 'Provider',
      slug: 'provider',
      dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
      models: [
        model,
        {
          ...model,
          endpoint: {
            provider_display_name: 'Provider',
            variant: 'free',
            is_free: true,
            pricing: { prompt: '0', completion: '0' },
            data_policy: { training: true, retainsPrompts: true },
          },
        },
      ],
    },
  ],
  total_providers: 1,
  total_models: 2,
  generated_at: '2026-09-24T00:00:00Z',
};

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getModelDataPolicies', () => {
  test('isolates exact variants and caches the latest snapshot for 30 seconds', async () => {
    const { getModelDataPolicies } = await import('./model-data-policy.server');
    const { fetchLatestModelsByProviderSnapshotFromDb } =
      await import('./models-by-provider-index.server');
    const fetchSnapshot = jest.mocked(fetchLatestModelsByProviderSnapshotFromDb);
    fetchSnapshot.mockResolvedValue(snapshot);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    const policies = await getModelDataPolicies();
    expect(policies.get('provider/model')).toEqual([
      { providerSlug: 'provider', training: false, retainsPrompts: false },
    ]);
    expect(policies.get('provider/model:free')).toEqual([
      { providerSlug: 'provider', training: true, retainsPrompts: true },
    ]);
    now.mockReturnValue(30_999);
    expect(await getModelDataPolicies()).toBe(policies);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    now.mockReturnValue(31_000);
    fetchSnapshot.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await getModelDataPolicies()).toBe(policies);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    fetchSnapshot.mockResolvedValue(undefined);
    expect(await getModelDataPolicies()).toEqual(new Map());
    expect(fetchSnapshot).toHaveBeenCalledTimes(3);
  });

  test.each(['missing', 'unavailable'])(
    'returns an empty map when the first snapshot is %s',
    async state => {
      const { getModelDataPolicies } = await import('./model-data-policy.server');
      const { fetchLatestModelsByProviderSnapshotFromDb } =
        await import('./models-by-provider-index.server');
      const fetchSnapshot = jest.mocked(fetchLatestModelsByProviderSnapshotFromDb);
      if (state === 'missing') fetchSnapshot.mockResolvedValue(undefined);
      else fetchSnapshot.mockRejectedValue(new Error('database unavailable'));

      expect(await getModelDataPolicies()).toEqual(new Map());
    }
  );
});

import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { INCEPTION_PROMO_MODEL } from '@/lib/constants';

export type FimProvider = 'mistral' | 'inception';

type SupportedFimModel = {
  id: string;
  upstreamModel: string;
  provider: FimProvider;
  snapshotModel: OpenRouterModel;
};

type ProviderModels = Array<{
  provider: Pick<OpenRouterProvider, 'slug'>;
  models: OpenRouterModel[];
}>;

export const CODESTRAL_FIM_MODEL_ID = 'mistralai/codestral-2508';
export const MERCURY_EDIT_FIM_MODEL_ID = INCEPTION_PROMO_MODEL;

/** Exact public IDs accepted by Kilo's FIM and edit routes. Aliases are intentionally omitted. */
export const SUPPORTED_FIM_MODELS = [
  {
    id: CODESTRAL_FIM_MODEL_ID,
    upstreamModel: 'codestral-2508',
    provider: 'mistral',
    snapshotModel: {
      slug: CODESTRAL_FIM_MODEL_ID,
      name: 'Mistral: Codestral 2508',
      author: 'Mistral',
      description: 'Mistral code model for fill-in-the-middle completions.',
      context_length: 256_000,
      input_modalities: ['text'],
      output_modalities: ['text'],
      group: 'Mistral',
      updated_at: '2025-08-01T00:00:00.000Z',
      endpoint: {
        provider_display_name: 'Mistral',
        is_free: false,
        pricing: {
          prompt: '0.000000300000',
          completion: '0.000000900000',
        },
      },
    },
  },
  {
    id: MERCURY_EDIT_FIM_MODEL_ID,
    upstreamModel: 'mercury-edit-2',
    provider: 'inception',
    snapshotModel: {
      slug: MERCURY_EDIT_FIM_MODEL_ID,
      name: 'Inception: Mercury Edit 2',
      author: 'Inception',
      description: 'Inception diffusion model for autocomplete and next-edit prediction.',
      context_length: 128_000,
      input_modalities: ['text'],
      output_modalities: ['text'],
      group: 'Inception',
      updated_at: '2026-07-29T00:00:00.000Z',
      endpoint: {
        provider_display_name: 'Inception',
        is_free: false,
        pricing: {
          prompt: '0.000000250000',
          completion: '0.000000750000',
        },
      },
    },
  },
] as const satisfies ReadonlyArray<SupportedFimModel>;

export function findSupportedFimModel(modelId: string): SupportedFimModel | undefined {
  return SUPPORTED_FIM_MODELS.find(model => model.id === modelId);
}

export function injectSupportedFimModels(providerModelData: ProviderModels): void {
  for (const supportedModel of SUPPORTED_FIM_MODELS) {
    const providerData = providerModelData.find(
      data => data.provider.slug === supportedModel.provider
    );
    if (!providerData) {
      console.warn(
        '[injectSupportedFimModels] Missing provider %s for supported FIM model %s',
        supportedModel.provider,
        supportedModel.id
      );
      continue;
    }
    if (providerData.models.some(model => model.slug === supportedModel.id)) continue;

    const endpoint: OpenRouterModel['endpoint'] = supportedModel.snapshotModel.endpoint;
    providerData.models.unshift({
      ...supportedModel.snapshotModel,
      input_modalities: [...supportedModel.snapshotModel.input_modalities],
      output_modalities: [...supportedModel.snapshotModel.output_modalities],
      endpoint: endpoint
        ? {
            ...endpoint,
            pricing: { ...endpoint.pricing },
            data_policy: endpoint.data_policy ? { ...endpoint.data_policy } : endpoint.data_policy,
          }
        : null,
    });
  }
}

import * as z from 'zod';
import { type DirectByokModel } from '@/lib/ai-gateway/providers/direct-byok/types';
import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { redisSet } from '@/lib/redis';
import { directByokModelsRedisKey } from '@/lib/redis-keys';

const DEFAULT_MAX_COMPLETION_TOKENS = 32_000;

const ModalitySchema = z
  .enum(['text', 'image', 'video', 'pdf', 'audio', 'unknown'])
  .catch('unknown');

const OpenAICompatibleModelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      context_length: z.number().optional(),
      max_model_len: z.number().optional(),
      max_output_length: z.number().optional(),
      input_modalities: z.array(ModalitySchema).optional(),
    })
  ),
});

const ModelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  limit: z
    .object({
      context: z.number().optional(),
      output: z.number().optional(),
    })
    .optional(),
  modalities: z
    .object({
      input: z.array(ModalitySchema).optional(),
      output: z.array(ModalitySchema).optional(),
    })
    .optional(),
});

const ModelsDevProviderSchema = z.object({
  models: z.record(z.string(), ModelsDevModelSchema),
});

type RawModel = {
  id: string;
  name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  input_modalities?: ReadonlyArray<z.infer<typeof ModalitySchema>>;
};

type ModelsDevCatalog = Record<string, unknown>;

type FetchContext = {
  modelsDevCatalog(): Promise<ModelsDevCatalog>;
};

type ProviderFetcher = {
  providerId: DirectUserByokInferenceProviderId;
  fetch(ctx: FetchContext): Promise<RawModel[]>;
};

function openAICompatibleFetcher(options: {
  providerId: DirectUserByokInferenceProviderId;
  label: string;
  url: string;
}): ProviderFetcher {
  return {
    providerId: options.providerId,
    async fetch() {
      const response = await fetch(options.url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${options.label} models: ${response.status} ${response.statusText}`
        );
      }
      const parsed = OpenAICompatibleModelsResponseSchema.parse(await response.json());
      return parsed.data.map(model => ({
        id: model.id,
        context_length: model.context_length ?? model.max_model_len,
        max_completion_tokens: model.max_output_length,
        input_modalities: model.input_modalities,
      }));
    },
  };
}

function modelsDevFetcher(
  providerId: DirectUserByokInferenceProviderId,
  catalogKey: string
): ProviderFetcher {
  return {
    providerId,
    async fetch(ctx) {
      const catalog = await ctx.modelsDevCatalog();
      const entry = catalog[catalogKey];
      if (!entry) {
        throw new Error(`models.dev catalog missing ${catalogKey} entry`);
      }
      const provider = ModelsDevProviderSchema.parse(entry);
      return Object.values(provider.models).map(model => ({
        id: model.id,
        name: model.name,
        context_length: model.limit?.context,
        max_completion_tokens: model.limit?.output,
        input_modalities: model.modalities?.input,
      }));
    },
  };
}

const FETCHERS: ReadonlyArray<ProviderFetcher> = [
  openAICompatibleFetcher({
    providerId: 'neuralwatt',
    label: 'Neuralwatt',
    url: 'https://api.neuralwatt.com/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'chutes-byok',
    label: 'Chutes',
    url: 'https://llm.chutes.ai/v1/models',
  }),
  modelsDevFetcher('zai-coding', 'zai-coding-plan'),
  modelsDevFetcher('ollama-cloud', 'ollama-cloud'),
];

function createFetchContext(): FetchContext {
  let cached: Promise<ModelsDevCatalog> | null = null;
  return {
    modelsDevCatalog() {
      return (cached ??= (async () => {
        const response = await fetch('https://models.dev/api.json');
        if (!response.ok) {
          throw new Error(
            `Failed to fetch models.dev catalog: ${response.status} ${response.statusText}`
          );
        }
        return z.record(z.string(), z.unknown()).parse(await response.json());
      })());
    },
  };
}

function bareModelId(id: string) {
  const afterVendor = id.slice(id.lastIndexOf('/') + 1);
  const colon = afterVendor.indexOf(':');
  return colon >= 0 ? afterVendor.slice(0, colon) : afterVendor;
}

async function syncProvider(fetcher: ProviderFetcher, ctx: FetchContext): Promise<number> {
  const fetched = await fetcher.fetch(ctx);
  const models: DirectByokModel[] = [];

  for (const raw of fetched) {
    const name = raw.name ?? bareModelId(raw.id);
    const context_length = raw.context_length ?? DEFAULT_MAX_COMPLETION_TOKENS;
    const max_completion_tokens = Math.min(
      raw.max_completion_tokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
      context_length
    );
    models.push({
      id: raw.id,
      name,
      flags: raw.input_modalities?.includes('image') ? ['vision'] : [],
      context_length,
      max_completion_tokens,
      variants: null,
    });
  }

  await redisSet(directByokModelsRedisKey(fetcher.providerId), JSON.stringify(models));
  return models.length;
}

export async function syncDirectByokModels(): Promise<
  Partial<Record<DirectUserByokInferenceProviderId, number>>
> {
  const ctx = createFetchContext();
  const entries = await Promise.all(
    FETCHERS.map(async fetcher => [fetcher.providerId, await syncProvider(fetcher, ctx)] as const)
  );
  return Object.fromEntries(entries);
}

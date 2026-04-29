import { createGateway, generateText } from 'ai';
import * as z from 'zod';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import {
  DirectByokModelArraySchema,
  type DirectByokModel,
} from '@/lib/ai-gateway/providers/direct-byok/types';
import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { StoredModel } from '@/lib/ai-gateway/providers/vercel/types';
import { redisGet, redisSet } from '@/lib/redis';
import { directByokModelsRedisKey } from '@/lib/redis-keys';

const DEFAULT_MAX_COMPLETION_TOKENS = 32_000;
const DESCRIPTION_MODEL = 'google/gemma-4-26b-a4b-it';

const NeuralwattModelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      max_model_len: z.number().optional(),
    })
  ),
});

const ModalitySchema = z
  .enum(['text', 'image', 'video', 'pdf', 'audio', 'unknown'])
  .catch('unknown');

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

type ProviderFetcher = {
  providerId: DirectUserByokInferenceProviderId;
  fetch(): Promise<RawModel[]>;
};

const FETCHERS: ReadonlyArray<ProviderFetcher> = [
  {
    providerId: 'neuralwatt',
    async fetch() {
      const response = await fetch('https://api.neuralwatt.com/v1/models');
      if (!response.ok) {
        throw new Error(
          `Failed to fetch Neuralwatt models: ${response.status} ${response.statusText}`
        );
      }
      const parsed = NeuralwattModelsResponseSchema.parse(await response.json());
      return parsed.data.map(model => ({
        id: model.id,
        context_length: model.max_model_len,
      }));
    },
  },
  {
    providerId: 'zai-coding',
    async fetch() {
      const response = await fetch('https://models.dev/api.json');
      if (!response.ok) {
        throw new Error(
          `Failed to fetch models.dev catalog: ${response.status} ${response.statusText}`
        );
      }
      const catalog = z.record(z.string(), z.unknown()).parse(await response.json());
      const entry = catalog['zai-coding-plan'];
      if (!entry) {
        throw new Error('models.dev catalog missing zai-coding-plan entry');
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
  },
];

function stripVendorPrefix(id: string) {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function stripVendorPrefixLowerCased(id: string) {
  return stripVendorPrefix(id).toLowerCase();
}

async function generateDescription(id: string, name: string): Promise<string> {
  const gateway = createGateway({ apiKey: PROVIDERS.VERCEL_AI_GATEWAY.apiKey });
  const { text } = await generateText({
    model: gateway(DESCRIPTION_MODEL),
    prompt:
      `Write a concise 1-2 sentence description of the AI model "${name}" ` +
      `(id: "${id}"), suitable for display in a model picker. ` +
      `Output only the description with no preamble or quoting.`,
    maxOutputTokens: 300,
  });
  return text.trim();
}

async function readPreviousModels(
  providerId: DirectUserByokInferenceProviderId
): Promise<DirectByokModel[]> {
  const raw = await redisGet(directByokModelsRedisKey(providerId));
  if (!raw) return [];
  return DirectByokModelArraySchema.parse(JSON.parse(raw));
}

async function syncProvider(
  fetcher: ProviderFetcher,
  fallbackDescriptions: ReadonlyMap<string, string>
): Promise<number> {
  const previous = await readPreviousModels(fetcher.providerId);
  const previousById = new Map(previous.map(model => [model.id, model]));

  const fetched = await fetcher.fetch();
  const models: DirectByokModel[] = [];

  for (const raw of fetched) {
    const prior = previousById.get(raw.id);
    const name = raw.name ?? stripVendorPrefix(raw.id);
    const fallbackDescription = fallbackDescriptions.get(stripVendorPrefixLowerCased(raw.id));
    const description =
      fallbackDescription ?? prior?.description ?? (await generateDescription(raw.id, name));
    const context_length = raw.context_length ?? DEFAULT_MAX_COMPLETION_TOKENS;
    const max_completion_tokens = Math.min(
      raw.max_completion_tokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
      context_length
    );
    models.push({
      id: raw.id,
      name,
      description,
      flags: raw.input_modalities?.includes('image') ? ['vision'] : [],
      context_length,
      max_completion_tokens,
      variants: null,
    });
  }

  await redisSet(directByokModelsRedisKey(fetcher.providerId), JSON.stringify(models));
  return models.length;
}

function buildFallbackDescriptions(sources: Record<string, StoredModel>[]): Map<string, string> {
  const fallbackDescriptions = new Map<string, string>();
  for (const source of sources) {
    for (const model of Object.values(source)) {
      const id = stripVendorPrefixLowerCased(model.id);
      if (!model.description || fallbackDescriptions.has(id)) continue;
      fallbackDescriptions.set(id, model.description);
    }
  }
  return fallbackDescriptions;
}

export async function syncDirectByokModels(
  openrouterData: Record<string, StoredModel>,
  vercelData: Record<string, StoredModel>
): Promise<Partial<Record<DirectUserByokInferenceProviderId, number>>> {
  const fallbackDescriptions = buildFallbackDescriptions([vercelData, openrouterData]);
  const entries = await Promise.all(
    FETCHERS.map(
      async fetcher =>
        [fetcher.providerId, await syncProvider(fetcher, fallbackDescriptions)] as const
    )
  );
  return Object.fromEntries(entries);
}

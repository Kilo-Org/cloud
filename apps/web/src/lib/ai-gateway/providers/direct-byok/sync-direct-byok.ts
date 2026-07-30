import * as z from 'zod';
import {
  type DirectByokModel,
  type DirectByokModelFlag,
} from '@/lib/ai-gateway/providers/direct-byok/types';
import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { redisClient } from '@/lib/redis';
import { directByokModelsRedisKey } from '@/lib/redis-keys';
import {
  ReasoningEffortSchema,
  VerbositySchema,
  type OpenCodeSettings,
} from '@kilocode/db/schema-types';
import {
  getAiSdkProvider,
  getModelVariants,
  REASONING_VARIANTS_BINARY,
} from '@/lib/ai-gateway/providers/model-settings';

const DEFAULT_CONTENT_LENGTH = 200_000;
const DEFAULT_MAX_COMPLETION_TOKENS = 32_000;

const ModalitySchema = z
  .enum(['text', 'image', 'video', 'pdf', 'audio', 'unknown'])
  .catch('unknown');

const OpenAICompatibleModelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().optional(),
      max_model_len: z.number().optional(),
      max_output_length: z.number().optional(),
      input_modalities: z.array(ModalitySchema).optional(),
      supported_features: z.array(z.string()).optional(),
    })
  ),
});

const ModelsDevReasoningOptionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('toggle') }),
  z.object({
    type: z.literal('effort'),
    values: z.array(z.union([z.null(), ReasoningEffortSchema, z.literal('default')])),
  }),
]);

const ModelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(ModelsDevReasoningOptionSchema).optional().catch(undefined),
  status: z.enum(['alpha', 'beta', 'deprecated']).optional().catch(undefined),
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
  tool_call: z.boolean().optional(),
});

const ModelsDevProviderSchema = z.object({
  models: z.record(z.string(), ModelsDevModelSchema),
});

const ModelsDevCatalogSchema = z.record(z.string(), z.unknown());

type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;

type RawModel = {
  id: string;
  name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  input_modalities?: ReadonlyArray<z.infer<typeof ModalitySchema>>;
  flags?: ReadonlyArray<DirectByokModelFlag>;
  variants?: OpenCodeSettings['variants'];
};

type ModelsDevProviderOptions = {
  availableModelIds?: ReadonlySet<string>;
};

type ModelsDevFetcherOptions = {
  availableModelsUrl?: string;
};

type SyncContext = {
  getModelsDevCatalog(): Promise<ModelsDevCatalog>;
};

type ProviderFetcher = {
  providerId: DirectUserByokInferenceProviderId;
  fetch(ctx: SyncContext): Promise<RawModel[]>;
};

function shortenDisplayName(id: string): string;
function shortenDisplayName(id: string | undefined): string | undefined;
function shortenDisplayName(id: string | undefined) {
  if (!id) return undefined;
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1).trim() : id;
}

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
      return parseOpenAICompatibleProviderModels(await response.json());
    },
  };
}

export function parseOpenAICompatibleProviderModels(entry: unknown): RawModel[] {
  const parsed = OpenAICompatibleModelsResponseSchema.parse(entry);
  return parsed.data
    .filter(model => !model.supported_features || model.supported_features.includes('tools'))
    .map(model => ({
      id: model.id,
      name: shortenDisplayName(model.name),
      context_length: model.context_length ?? model.max_model_len,
      max_completion_tokens: model.max_output_length,
      input_modalities: model.input_modalities,
      flags: ['reasoning'],
    }));
}

function modelsDevReasoningOptionsToVariants(
  options: ReadonlyArray<z.infer<typeof ModelsDevReasoningOptionSchema>>
): OpenCodeSettings['variants'] {
  const hasToggle = options.some(option => option.type === 'toggle');
  const effortVariants: NonNullable<OpenCodeSettings['variants']> = {};
  for (const option of options) {
    if (option.type !== 'effort') continue;
    for (const value of option.values) {
      const effort = ReasoningEffortSchema.safeParse(value);
      if (!effort.success) continue;
      effortVariants[effort.data] = {
        reasoning: { enabled: effort.data !== 'none', effort: effort.data },
      };
    }
  }

  if (Object.keys(effortVariants).length > 0) {
    return hasToggle && !effortVariants.none
      ? { none: { reasoning: { enabled: false, effort: 'none' } }, ...effortVariants }
      : effortVariants;
  }
  if (hasToggle) {
    return REASONING_VARIANTS_BINARY;
  }
  return undefined;
}

function addAnthropicVariantVerbosity(
  variants: OpenCodeSettings['variants'],
  aiSdkProvider: OpenCodeSettings['ai_sdk_provider']
): OpenCodeSettings['variants'] {
  if (aiSdkProvider !== 'anthropic' || !variants) return variants;

  return Object.fromEntries(
    Object.entries(variants).map(([name, variant]) => {
      const verbosity = VerbositySchema.safeParse(variant.reasoning?.effort);
      return [name, verbosity.success ? { ...variant, verbosity: verbosity.data } : variant];
    })
  );
}

export function parseModelsDevProviderModels(
  entry: unknown,
  providerId: DirectUserByokInferenceProviderId,
  options: ModelsDevProviderOptions = {}
): RawModel[] {
  const provider = ModelsDevProviderSchema.parse(entry);
  return Object.values(provider.models)
    .filter(
      model =>
        model.status !== 'deprecated' &&
        (!model.modalities?.output || model.modalities.output.includes('text')) &&
        (!options.availableModelIds || options.availableModelIds.has(model.id)) &&
        model.tool_call !== false &&
        (!model.modalities?.input || model.modalities.input.includes('text'))
    )
    .map(model => {
      const modelId = `${providerId}/${model.id}`.toLowerCase();
      const aiSdkProvider = getAiSdkProvider(modelId, providerId);
      const variants =
        modelsDevReasoningOptionsToVariants(model.reasoning_options ?? []) ??
        getModelVariants(modelId);
      return {
        id: model.id,
        name: shortenDisplayName(model.name),
        context_length: model.limit?.context,
        max_completion_tokens: model.limit?.output,
        input_modalities: model.modalities?.input,
        flags: model.reasoning ? ['reasoning'] : undefined,
        variants: addAnthropicVariantVerbosity(variants, aiSdkProvider),
      };
    });
}

function modelsDevFetcher(
  providerId: DirectUserByokInferenceProviderId,
  catalogKey: string,
  options: ModelsDevFetcherOptions = {}
): ProviderFetcher {
  return {
    providerId,
    async fetch(ctx) {
      const catalog = await ctx.getModelsDevCatalog();
      const entry = catalog[catalogKey];
      if (!entry) {
        throw new Error(`models.dev catalog missing ${catalogKey} entry`);
      }
      let availableModelIds: ReadonlySet<string> | undefined;
      if (options.availableModelsUrl) {
        const response = await fetch(options.availableModelsUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch ${providerId} available models: ${response.status} ${response.statusText}`
          );
        }
        availableModelIds = new Set(
          OpenAICompatibleModelsResponseSchema.parse(await response.json()).data.map(
            model => model.id
          )
        );
      }
      return parseModelsDevProviderModels(entry, providerId, {
        availableModelIds,
      });
    },
  };
}

async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog> {
  const response = await fetch('https://models.dev/api.json');
  if (!response.ok) {
    throw new Error(
      `Failed to fetch models.dev catalog: ${response.status} ${response.statusText}`
    );
  }
  return ModelsDevCatalogSchema.parse(await response.json());
}

const FETCHERS: ReadonlyArray<ProviderFetcher> = [
  openAICompatibleFetcher({
    providerId: 'neuralwatt',
    label: 'Neuralwatt',
    url: 'https://api.neuralwatt.com/v1/models',
  }),
  modelsDevFetcher('nvidia-byok', 'nvidia', {
    availableModelsUrl: 'https://integrate.api.nvidia.com/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'chutes-byok',
    label: 'Chutes',
    url: 'https://llm.chutes.ai/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'crofai',
    label: 'CrofAI',
    url: 'https://crof.ai/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'orcarouter',
    label: 'OrcaRouter',
    url: 'https://api.orcarouter.ai/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'inceptron-byok',
    label: 'Inceptron BYOK',
    url: 'https://api.inceptron.io/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'martian',
    label: 'Martian',
    url: 'https://api.withmartian.com/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'synthetic',
    label: 'Synthetic',
    url: 'https://api.synthetic.new/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'morph-byok',
    label: 'Morph BYOK',
    url: 'https://www.morphllm.com/api/models/json',
  }),
  modelsDevFetcher('alibaba-token-plan', 'alibaba-token-plan'),
  modelsDevFetcher('zai-coding', 'zai-coding-plan'),
  modelsDevFetcher('ollama-cloud', 'ollama-cloud', {
    availableModelsUrl: 'https://ollama.com/v1/models',
  }),
  modelsDevFetcher('opencode-go', 'opencode-go', {
    availableModelsUrl: 'https://opencode.ai/zen/go/v1/models',
  }),
  modelsDevFetcher('xiaomi-token-plan-ams', 'xiaomi-token-plan-ams'),
  modelsDevFetcher('xiaomi-token-plan-sgp', 'xiaomi-token-plan-sgp'),
];

async function syncProvider(fetcher: ProviderFetcher, ctx: SyncContext): Promise<number> {
  const fetched = await fetcher.fetch(ctx);
  const models: DirectByokModel[] = [];

  for (const raw of fetched) {
    const name = raw.name ?? shortenDisplayName(raw.id);
    const context_length = raw.context_length ?? DEFAULT_CONTENT_LENGTH;
    const flags = new Set(raw.flags);
    if (raw.input_modalities?.includes('image')) flags.add('vision');
    const max_completion_tokens = Math.min(
      raw.max_completion_tokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
      context_length
    );
    models.push({
      id: raw.id,
      name,
      flags: flags.size > 0 ? [...flags] : undefined,
      context_length,
      max_completion_tokens,
      variants: raw.variants,
    });
  }

  await redisClient.set(directByokModelsRedisKey(fetcher.providerId), JSON.stringify(models));
  return models.length;
}

export async function syncDirectByokModels(): Promise<
  Partial<Record<DirectUserByokInferenceProviderId, number>>
> {
  let catalogPromise: Promise<ModelsDevCatalog> | null = null;
  const ctx: SyncContext = {
    getModelsDevCatalog() {
      catalogPromise ??= fetchModelsDevCatalog();
      return catalogPromise;
    },
  };
  const entries = await Promise.all(
    FETCHERS.map(async fetcher => [fetcher.providerId, await syncProvider(fetcher, ctx)] as const)
  );
  return Object.fromEntries(entries);
}

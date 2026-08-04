import {
  UserByokProviderIdSchema,
  type UserByokProviderId,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  COMPATIBLE_USER_AGENT,
  type DirectByokModel,
  type DirectByokProvider,
} from '@/lib/ai-gateway/providers/direct-byok/types';
import { DIRECT_BYOK_PROVIDERS_META } from '@/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import DIRECT_BYOK_PROVIDERS from './direct-byok-definitions';
import { getBYOKforOrganization, getBYOKforUser } from '@/lib/ai-gateway/byok';
import { readDb, type DrizzleTransaction } from '@/lib/drizzle';
import { preferredModels } from '@/lib/ai-gateway/models';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { OpenCodeSettings } from '@kilocode/db';
import { getAiSdkProvider, getModelVariants } from '@/lib/ai-gateway/providers/model-settings';
import { getFallbackModelVariants } from '@/lib/ai-gateway/providers/variants';
import { and, eq, like } from 'drizzle-orm';
import { byok_api_keys } from '@kilocode/db/schema';
import { decryptByokRow } from '@/lib/ai-gateway/byok';
import {
  formatManualByokModelId,
  isManualByokEnabled,
  ManualByokProviderIdSchema,
  resolveManualByokModel,
  safeParseManualByokProviderDefinition,
} from './manual-byok';
import type { ManualByokProviderDefinition } from '@kilocode/db/schema-types';

export function formatDirectByokModelId(provider: DirectByokProvider, model: DirectByokModel) {
  return (provider.id + '/' + model.id).toLowerCase();
}

function convertModel(
  provider: DirectByokProvider,
  model: DirectByokModel,
  preferredIndex: number
) {
  const id = formatDirectByokModelId(provider, model);
  const name = DIRECT_BYOK_PROVIDERS_META[provider.id] + ': ' + model.name;
  return {
    id,
    canonical_slug: id,
    hugging_face_id: '',
    name,
    created: 631148400, // our clients do not care about this field, we can fix it later if that changes
    description: '',
    context_length: model.context_length,
    architecture: {
      modality: model.flags?.includes('vision') ? 'text+image-\u003Etext' : 'text-\u003Etext',
      input_modalities: ['text'].concat(model.flags?.includes('vision') ? ['image'] : []),
      output_modalities: ['text'],
      tokenizer: 'Other',
      instruct_type: null,
    },
    pricing: {
      prompt: '0.0000000',
      completion: '0.0000000',
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
      input_cache_read: '0.00000000',
    },
    top_provider: {
      context_length: model.context_length,
      max_completion_tokens: model.max_completion_tokens,
      is_moderated: false,
    },
    per_request_limits: null,
    supported_parameters: ['max_tokens', 'temperature', 'tools'].concat(
      model.flags?.includes('reasoning') ? ['reasoning'] : []
    ),
    default_parameters: {},
    preferredIndex: model.flags?.includes('recommended') ? preferredIndex : undefined,
    hasUserByokAvailable: true,
    opencode: {
      ai_sdk_provider: getAiSdkProvider(id, provider.id) ?? provider.default_ai_sdk_provider,
      variants:
        model.variants ??
        (model.flags?.includes('reasoning') ? getFallbackModelVariants(id) : undefined),
    } satisfies OpenCodeSettings,
  };
}

async function convertManualModel(
  providerId: `manual:${string}`,
  definition: ManualByokProviderDefinition,
  model: ManualByokProviderDefinition['models'][number]
) {
  const resolved = resolveManualByokModel(definition, model);
  const id = formatManualByokModelId(providerId, model.id);
  return {
    id,
    canonical_slug: id,
    hugging_face_id: '',
    name: `${definition.name}: ${resolved.name}`,
    created: 631148400,
    description: '',
    context_length: resolved.contextLength,
    architecture: {
      modality: resolved.supportsImageInput ? 'text+image-\u003Etext' : 'text-\u003Etext',
      input_modalities: ['text'].concat(resolved.supportsImageInput ? ['image'] : []),
      output_modalities: ['text'],
      tokenizer: 'Other',
      instruct_type: null,
    },
    pricing: {
      prompt: '0.0000000',
      completion: '0.0000000',
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
      input_cache_read: '0.00000000',
    },
    top_provider: {
      context_length: resolved.contextLength,
      max_completion_tokens: resolved.maxCompletionTokens,
      is_moderated: false,
    },
    per_request_limits: null,
    supported_parameters: ['max_tokens', 'temperature', 'tools'].concat(
      resolved.supportsReasoning ? ['reasoning'] : []
    ),
    default_parameters: {},
    hasUserByokAvailable: true,
    opencode: {
      ai_sdk_provider: resolved.preferredAiSdkProvider,
      variants: await getModelVariants(id, resolved.supportsReasoning),
    } satisfies OpenCodeSettings,
  };
}

async function getManualByokModels(owner: { userId: string } | { organizationId: string }) {
  if (!isManualByokEnabled()) return [];
  const rows = await readDb
    .select({
      provider_id: byok_api_keys.provider_id,
      provider_settings: byok_api_keys.provider_settings,
    })
    .from(byok_api_keys)
    .where(
      and(
        'userId' in owner
          ? eq(byok_api_keys.kilo_user_id, owner.userId)
          : eq(byok_api_keys.organization_id, owner.organizationId),
        eq(byok_api_keys.is_enabled, true),
        like(byok_api_keys.provider_id, 'manual:%')
      )
    );
  const models: Awaited<ReturnType<typeof convertManualModel>>[] = [];
  for (const row of rows) {
    const providerId = ManualByokProviderIdSchema.safeParse(row.provider_id);
    const definition = safeParseManualByokProviderDefinition(row.provider_settings);
    if (!providerId.success || !definition.success) continue;
    models.push(
      ...(await Promise.all(
        definition.data.models.map(model =>
          convertManualModel(providerId.data, definition.data, model)
        )
      ))
    );
  }
  return models;
}

export async function getManualByokCredential(
  requestedModel: string,
  owner: { userId: string } | { organizationId: string },
  fromDb: typeof readDb | DrizzleTransaction = readDb
) {
  if (!isManualByokEnabled()) return null;
  const slash = requestedModel.indexOf('/');
  if (slash < 0) return null;
  const providerId = ManualByokProviderIdSchema.safeParse(requestedModel.slice(0, slash));
  if (!providerId.success) return null;
  const [row] = await fromDb
    .select({
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      provider_id: byok_api_keys.provider_id,
      provider_settings: byok_api_keys.provider_settings,
    })
    .from(byok_api_keys)
    .where(
      and(
        'userId' in owner
          ? eq(byok_api_keys.kilo_user_id, owner.userId)
          : eq(byok_api_keys.organization_id, owner.organizationId),
        eq(byok_api_keys.provider_id, providerId.data),
        eq(byok_api_keys.is_enabled, true)
      )
    );
  if (!row) return null;
  const definition = safeParseManualByokProviderDefinition(row.provider_settings);
  if (!definition.success) return null;
  const model = definition.data.models.find(
    candidate => formatManualByokModelId(providerId.data, candidate.id) === requestedModel
  );
  if (!model) return null;
  return {
    providerId: providerId.data,
    definition: definition.data,
    model,
    resolvedModel: resolveManualByokModel(definition.data, model),
    byok: decryptByokRow(row),
  };
}

async function getDirectByokModels(byokProviders: UserByokProviderId[]) {
  let nextPreferredId = preferredModels.length;
  return (
    await Promise.all(
      DIRECT_BYOK_PROVIDERS.filter(provider => byokProviders.includes(provider.id)).map(
        async provider =>
          (await provider.models()).map(model => convertModel(provider, model, nextPreferredId++))
      )
    )
  ).flat();
}

export async function getDirectByokModel(requestedModel: string): Promise<{
  provider: DirectByokProvider | null;
  model: DirectByokModel | null;
}> {
  const provider = DIRECT_BYOK_PROVIDERS.find(provider =>
    requestedModel.startsWith(`${provider.id}/`)
  );
  if (!provider) {
    return { provider: null, model: null };
  }

  const model = (await provider.models()).find(
    model => formatDirectByokModelId(provider, model) === requestedModel
  );
  if (model) {
    return { provider, model };
  }

  return { provider: null, model: null };
}

export async function getDirectByokModelsForOrganization(organizationId: string) {
  const userByok = await getBYOKforOrganization(
    readDb,
    organizationId,
    DIRECT_BYOK_PROVIDERS.map(provider => provider.id)
  );
  const providerIds =
    userByok?.flatMap(entry => {
      const parsed = UserByokProviderIdSchema.safeParse(entry.providerId);
      return parsed.success ? [parsed.data] : [];
    }) ?? [];
  const directModels = await getDirectByokModels(providerIds);
  const manualModels = await getManualByokModels({ organizationId });
  return [...directModels, ...manualModels];
}

export async function getDirectByokModelsForUser(userId: string) {
  const userByok = await getBYOKforUser(
    readDb,
    userId,
    DIRECT_BYOK_PROVIDERS.map(provider => provider.id)
  );
  const providerIds =
    userByok?.flatMap(entry => {
      const parsed = UserByokProviderIdSchema.safeParse(entry.providerId);
      return parsed.success ? [parsed.data] : [];
    }) ?? [];
  const directModels = await getDirectByokModels(providerIds);
  const manualModels = await getManualByokModels({ userId });
  return [...directModels, ...manualModels];
}

export function createAiSdkProvider(directByokProvider: DirectByokProvider, apiKey: string) {
  return createOpenAICompatible({
    baseURL: directByokProvider.base_url,
    apiKey,
    name: 'openaiCompatible',
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('user-agent', COMPATIBLE_USER_AGENT);
      return fetch(url, init ? { ...init, headers } : { headers });
    },
  });
}

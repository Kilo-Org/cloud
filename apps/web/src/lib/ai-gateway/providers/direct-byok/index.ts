import { type UserByokProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  COMPATIBLE_USER_AGENT,
  type DirectByokModel,
  type DirectByokProvider,
} from '@/lib/ai-gateway/providers/direct-byok/types';
import DIRECT_BYOK_PROVIDERS from './direct-byok-definitions';
import { getBYOKforOrganization, getBYOKforUser } from '@/lib/ai-gateway/byok';
import { readDb } from '@/lib/drizzle';
import { preferredModels } from '@/lib/ai-gateway/models';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { OpenCodeSettings } from '@kilocode/db';

export function formatDirectByokModelId(provider: DirectByokProvider, model: DirectByokModel) {
  return (provider.id + '/' + model.id).toLowerCase();
}

function convertModel(
  provider: DirectByokProvider,
  model: DirectByokModel,
  preferredIndex: number
) {
  const id = formatDirectByokModelId(provider, model);
  const name = provider.name + ': ' + model.name;
  return {
    id,
    canonical_slug: id,
    hugging_face_id: '',
    name,
    created: 631148400, // our clients do not care about this field, we can fix it later if that changes
    description: model.description,
    context_length: model.context_length,
    architecture: {
      modality: model.flags.includes('vision') ? 'text+image-\u003Etext' : 'text-\u003Etext',
      input_modalities: ['text'].concat(model.flags.includes('vision') ? ['image'] : []),
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
    supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning', 'include_reasoning'],
    default_parameters: {},
    preferredIndex: model.flags.includes('recommended') ? preferredIndex : undefined,
    opencode: {
      ai_sdk_provider: provider.ai_sdk_provider,
      variants: model.variants ?? undefined,
    } satisfies OpenCodeSettings,
  };
}

function getDirectByokModels(byokProviders: UserByokProviderId[]) {
  let nextPreferredId = preferredModels.length;
  return DIRECT_BYOK_PROVIDERS.filter(provider => byokProviders.includes(provider.id)).flatMap(
    provider => provider.models.map(model => convertModel(provider, model, nextPreferredId++))
  );
}

export function getDirectByokModel(requestedModel: string): {
  provider: DirectByokProvider | null;
  model: DirectByokModel | null;
} {
  for (const provider of DIRECT_BYOK_PROVIDERS) {
    const model = provider?.models.find(
      model => formatDirectByokModelId(provider, model) === requestedModel
    );
    if (model) {
      return { provider, model };
    }
  }
  return { provider: null, model: null };
}

export async function getDirectByokModelsForOrganization(organizationId: string) {
  const userByok = await getBYOKforOrganization(
    readDb,
    organizationId,
    DIRECT_BYOK_PROVIDERS.map(provider => provider.id)
  );
  return userByok ? getDirectByokModels(userByok.map(ub => ub.providerId)) : [];
}

export async function getDirectByokModelsForUser(userId: string) {
  const userByok = await getBYOKforUser(
    readDb,
    userId,
    DIRECT_BYOK_PROVIDERS.map(provider => provider.id)
  );
  return userByok ? getDirectByokModels(userByok.map(ub => ub.providerId)) : [];
}

export function createAiSdkProvider(directByokProvider: DirectByokProvider, apiKey: string) {
  if (directByokProvider.ai_sdk_provider === 'openai-compatible') {
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
  } else {
    throw new Error('Unrecognized AI SDK provider: ' + directByokProvider.ai_sdk_provider);
  }
}

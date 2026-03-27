import { type UserByokProviderId } from '@/lib/providers/openrouter/inference-provider-id';
import type { CodingPlanModel, CodingPlanProvider } from '@/lib/providers/coding-plans/types';
import CODING_PLANS from './coding-plan-definitions';
import { getBYOKforOrganization, getBYOKforUser } from '@/lib/byok';
import { readDb } from '@/lib/drizzle';
import { preferredModels } from '@/lib/models';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export function formatCodingPlanModelId(provider: CodingPlanProvider, model: CodingPlanModel) {
  return provider.id + '/' + model.id;
}

function convertModel(
  provider: CodingPlanProvider,
  model: CodingPlanModel,
  preferredIndex: number
) {
  const id = formatCodingPlanModelId(provider, model);
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
  };
}

function getCodingPlanModels(byokProviders: UserByokProviderId[]) {
  let nextPreferredId = preferredModels.length;
  return CODING_PLANS.filter(codingPlan => byokProviders.includes(codingPlan.id)).flatMap(
    provider => provider.models.map(model => convertModel(provider, model, nextPreferredId++))
  );
}

export function getCodingPlanModel(requestedModel: string): {
  provider: CodingPlanProvider | null;
  model: CodingPlanModel | null;
} {
  for (const provider of CODING_PLANS) {
    const model = provider?.models.find(
      model => formatCodingPlanModelId(provider, model) === requestedModel
    );
    if (model) {
      return { provider, model };
    }
  }
  return { provider: null, model: null };
}

export async function getCodingPlanModelsForOrganization(organizationId: string) {
  const userByok = await getBYOKforOrganization(
    readDb,
    organizationId,
    CODING_PLANS.map(provider => provider.id)
  );
  return userByok ? getCodingPlanModels(userByok.map(ub => ub.providerId)) : [];
}

export async function getCodingPlanModelsForUser(userId: string) {
  const userByok = await getBYOKforUser(
    readDb,
    userId,
    CODING_PLANS.map(provider => provider.id)
  );
  return userByok ? getCodingPlanModels(userByok.map(ub => ub.providerId)) : [];
}

export function createAiSdkProvider(codingPlanProvider: CodingPlanProvider, apiKey: string) {
  if (codingPlanProvider.ai_sdk_provider === 'openai-compatible') {
    return createOpenAICompatible({
      baseURL: codingPlanProvider.base_url,
      apiKey,
      name: 'openaiCompatible',
    });
  } else {
    throw new Error('Unrecognized AI SDK provider: ' + codingPlanProvider.ai_sdk_provider);
  }
}

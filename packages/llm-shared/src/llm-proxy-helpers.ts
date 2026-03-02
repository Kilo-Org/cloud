import type {
  OpenRouterChatCompletionRequest,
  OpenRouterProviderConfig,
} from './openrouter-types.js';
import { normalizeModelId } from './model-utils.js';
import { extraRequiredProviders } from './models.js';

export function estimateChatTokens(body: OpenRouterChatCompletionRequest): {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
} {
  if (!body.messages || !Array.isArray(body.messages)) {
    return { estimatedInputTokens: 0, estimatedOutputTokens: 0 };
  }
  const overallLength = body.messages.reduce(
    (sum, m) =>
      sum +
      (typeof m.content === 'string'
        ? m.content?.length
        : Array.isArray(m.content)
          ? m.content
              .filter(c => c.type === 'text')
              .map(c => c.text.length)
              .reduce((l, str) => str + 1 + l, 0)
          : 0),
    0
  );
  return {
    estimatedInputTokens: overallLength / 4,
    estimatedOutputTokens: overallLength / 4,
  };
}

export type OrganizationPlan = 'teams' | 'enterprise';

export type OrganizationSettings = {
  model_allow_list?: string[];
  provider_allow_list?: string[];
  data_collection?: 'allow' | 'deny';
};

export type OrganizationRestrictionResult = {
  error: { status: number; message: string } | null;
  providerConfig?: OpenRouterProviderConfig;
};

export function checkOrganizationModelRestrictions(params: {
  modelId: string;
  settings?: OrganizationSettings;
  organizationPlan?: OrganizationPlan;
}): OrganizationRestrictionResult {
  if (!params.settings) return { error: null };

  const normalizedModelId = normalizeModelId(params.modelId);

  if (params.organizationPlan === 'enterprise') {
    const modelAllowList = params.settings.model_allow_list || [];

    if (modelAllowList.length > 0) {
      const isExactMatch = modelAllowList.includes(normalizedModelId);

      const providerSlug = normalizedModelId.split('/')[0];
      const wildcardEntry = `${providerSlug}/*`;
      const isWildcardMatch = modelAllowList.includes(wildcardEntry);

      if (!isExactMatch && !isWildcardMatch) {
        return { error: { status: 404, message: 'Model not allowed for your team.' } };
      }
    }
  }

  const providerAllowList = params.settings.provider_allow_list || [];
  const dataCollection = params.settings.data_collection;

  const providerConfig: OpenRouterProviderConfig = {};

  if (params.organizationPlan === 'enterprise' && providerAllowList.length > 0) {
    const requiredProviders = extraRequiredProviders(normalizedModelId);
    if (
      requiredProviders.length > 0 &&
      !requiredProviders.every(p => providerAllowList.includes(p))
    ) {
      console.error(
        `This FREE model requires ALL of these providers to be allowed: ${requiredProviders.join(', ')}`
      );
      return { error: { status: 404, message: 'Model not allowed for your team.' } };
    }
    providerConfig.only = providerAllowList;
  }

  if (dataCollection) {
    providerConfig.data_collection = dataCollection;
  }

  return {
    error: null,
    providerConfig: Object.keys(providerConfig).length > 0 ? providerConfig : undefined,
  };
}

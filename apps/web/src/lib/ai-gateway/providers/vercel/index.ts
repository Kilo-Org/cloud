import type { BYOKResult } from '@/lib/ai-gateway/providers/types';
import type { VercelUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  DirectUserByokInferenceProviderIdSchema,
  AwsCredentialsSchema,
  normalizeVercelInferenceProviderIdForRouting,
  openRouterToVercelInferenceProviderId,
  VertexCredentialsSchema,
  VercelUserByokInferenceProviderIdSchema,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type {
  GatewayRequest,
  OpenRouterProviderConfig,
  VercelInferenceProviderConfig,
  VercelProviderConfig,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import {
  getCachedVercelInferenceProviderIdsForModel,
  getVercelModelsFromRedis,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { getRuntimeGatewayRoutingConfig } from '@/lib/ai-gateway/providers/routing-config';
import { passesRoutingPercentage } from '@/lib/ai-gateway/providers/routing-percentage';
import { getEnvVariable } from '@/lib/dotenvx';
import { gpt_5_6_sol_discounted_model } from '@/lib/ai-gateway/providers/openai-exclusive';

export function hasCompatibleVercelInferenceProvider(
  openRouterInferenceProviders: string[],
  vercelInferenceProviders: string[] | null
) {
  if (!vercelInferenceProviders) {
    return true;
  }

  return openRouterInferenceProviders.some(provider => {
    const vercelProviderId = openRouterToVercelInferenceProviderId(provider);
    return vercelInferenceProviders
      .map(providerId => normalizeVercelInferenceProviderIdForRouting(providerId))
      .includes(vercelProviderId);
  });
}

export function getVercelInferenceProvidersExcludingIgnored(
  ignoredProviders: string[],
  onlyProviders: string[] | undefined,
  vercelInferenceProviders: string[]
) {
  const ignored = new Set(ignoredProviders.map(openRouterToVercelInferenceProviderId));
  const only = onlyProviders
    ? new Set(onlyProviders.map(openRouterToVercelInferenceProviderId))
    : null;

  return [
    ...new Set(
      vercelInferenceProviders
        .map(providerId => normalizeVercelInferenceProviderIdForRouting(providerId))
        .filter(provider => !ignored.has(provider) && (!only || only.has(provider)))
    ),
  ];
}

export function passesVercelRoutingPercentage(randomSeed: string, routingPercentage: number) {
  return passesRoutingPercentage('vercel', randomSeed, routingPercentage);
}

export function isVercelRoutingOptOut(requestedModel: string, optOutModels: ReadonlySet<string>) {
  return optOutModels.has(requestedModel);
}

export async function shouldRouteToVercel(
  requestedModel: string,
  request: GatewayRequest,
  randomSeed: string,
  getRoutingProviderConfig: () => Promise<OpenRouterProviderConfig | undefined>
) {
  const routingConfig = await getRuntimeGatewayRoutingConfig();
  if (isVercelRoutingOptOut(requestedModel, routingConfig.vercelOptOutModels)) {
    console.debug(`[shouldRouteToVercel] model ${requestedModel} opted out of Vercel routing`);
    return false;
  }

  console.debug('[shouldRouteToVercel] randomizing user to either OpenRouter or Vercel');
  const routingPercentage = (await isFreeModel(requestedModel))
    ? routingConfig.vercelFree
    : routingConfig.vercelPaid;

  const passedRandomization = passesVercelRoutingPercentage(randomSeed, routingPercentage);

  if (!passedRandomization) {
    return false;
  }

  const vercelModels = await getVercelModelsFromRedis();
  const vercelModelId = mapModelIdToVercel(requestedModel);
  if (!vercelModels.has(vercelModelId)) {
    console.debug(`[shouldRouteToVercel] model not found in Vercel model list`);
    return false;
  }

  const provider = await getRoutingProviderConfig();
  if (provider && (provider.only || provider.ignore?.length)) {
    const { only, ignore } = provider;
    const vercelInferenceProviders =
      await getCachedVercelInferenceProviderIdsForModel(vercelModelId);

    if (ignore?.length) {
      if (!vercelInferenceProviders) {
        console.debug(
          '[shouldRouteToVercel] not routing to Vercel because inference provider data is unavailable'
        );
        return false;
      }

      const effectiveOnly = getVercelInferenceProvidersExcludingIgnored(
        ignore,
        only,
        vercelInferenceProviders
      );
      if (effectiveOnly.length === 0) {
        console.debug(
          '[shouldRouteToVercel] no inference providers remain after applying provider preferences'
        );
        return false;
      }
    } else if (only && !hasCompatibleVercelInferenceProvider(only, vercelInferenceProviders)) {
      console.debug(
        '[shouldRouteToVercel] none of the requested inference providers are available on Vercel'
      );
      return false;
    }
  }

  return true;
}

export function convertProviderOptions(
  requestToMutate: GatewayRequest,
  vercelInferenceProviders: string[] | null
): VercelProviderConfig {
  const provider = requestToMutate.body.provider;
  const only = (() => {
    if (!provider?.ignore?.length) {
      return provider?.only?.map(openRouterToVercelInferenceProviderId);
    }
    if (!vercelInferenceProviders) {
      throw new Error('Vercel inference provider data became unavailable during request transform');
    }
    return getVercelInferenceProvidersExcludingIgnored(
      provider.ignore,
      provider.only,
      vercelInferenceProviders
    );
  })();

  return {
    gateway: {
      only,
      order: provider?.order?.map(openRouterToVercelInferenceProviderId),
      zeroDataRetention: provider?.zdr,
      disallowPromptTraining: provider?.data_collection === 'deny' || undefined,
      models: requestToMutate.body.models,
    },
  };
}

function parseAwsCredentials(input: string) {
  try {
    return AwsCredentialsSchema.parse(JSON.parse(input));
  } catch {
    throw new Error('Failed to parse AWS credentials');
  }
}

function parseVertexCredentials(input: string) {
  try {
    return VertexCredentialsSchema.parse(JSON.parse(input));
  } catch {
    throw new Error('Failed to parse Google Vertex credentials');
  }
}

export function getAnthropicProviderOptionsForVercel(
  request: GatewayRequest
): AnthropicProviderOptions | undefined {
  const anthropicOptions: AnthropicProviderOptions = {};

  if (request.kind === 'chat_completions' && request.body.verbosity) {
    anthropicOptions.effort = request.body.verbosity;
  }
  if (request.kind === 'responses' && request.body.text?.verbosity) {
    anthropicOptions.effort = request.body.text.verbosity;
  }

  if (Object.keys(anthropicOptions).length === 0) {
    return undefined;
  }

  return anthropicOptions;
}

export function getVercelInferenceProviderConfigForUserByok(
  provider: BYOKResult
): [VercelUserByokInferenceProviderId, VercelInferenceProviderConfig[]] {
  const key =
    provider.providerId === DirectUserByokInferenceProviderIdSchema.enum.codestral
      ? VercelUserByokInferenceProviderIdSchema.enum.mistral
      : VercelUserByokInferenceProviderIdSchema.parse(provider.providerId);

  const list = new Array<VercelInferenceProviderConfig>();

  if (key === VercelUserByokInferenceProviderIdSchema.enum.zai) {
    // Z.ai Coding Plan support
    // ideally we remove this and have people use the explicit Z.ai Coding Plan option,
    // but that's a breaking change
    list.push({
      apiKey: provider.decryptedAPIKey,
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
    });
  }

  if (key === VercelUserByokInferenceProviderIdSchema.enum.bedrock) {
    list.push(parseAwsCredentials(provider.decryptedAPIKey));
  } else if (key === VercelUserByokInferenceProviderIdSchema.enum.vertex) {
    list.push(parseVertexCredentials(provider.decryptedAPIKey));
  } else {
    list.push({ apiKey: provider.decryptedAPIKey });
  }
  return [key, list];
}

export async function applyVercelSettings(
  requestedModel: string,
  requestToMutate: GatewayRequest,
  userByok: BYOKResult[] | null
) {
  const vercelModelId = mapModelIdToVercel(requestedModel);
  requestToMutate.body.model = vercelModelId;

  if (userByok) {
    if (userByok.length === 0) {
      throw new Error('Invalid state: userByok should be null or not empty');
    }
    // Only honor the caller's own `provider.ignore` here. The organization /
    // group `provider.only` allow-list must NOT constrain BYOK selection:
    // direct BYOK uses the user's own credentials and is intentionally exempt
    // from organization model/provider restrictions (see ai-gateway AGENTS.md).
    // Filtering by it also silently drops providers whose OpenRouter slug has
    // no Vercel BYOK equivalent, turning previously working requests into hard
    // failures.
    const ignoredProviders = new Set(
      (requestToMutate.body.provider?.ignore ?? []).map(openRouterToVercelInferenceProviderId)
    );
    const allByokProviders: Record<string, VercelInferenceProviderConfig[]> = {};
    const retainedByokProviders: Record<string, VercelInferenceProviderConfig[]> = {};
    for (const provider of userByok) {
      const [key, list] = getVercelInferenceProviderConfigForUserByok(provider);
      allByokProviders[key] = [...(allByokProviders[key] ?? []), ...list];
      if (!ignoredProviders.has(key)) {
        retainedByokProviders[key] = [...(retainedByokProviders[key] ?? []), ...list];
      }
    }
    // `provider.ignore` is a routing preference, not an authorization boundary,
    // so it must never remove the last BYOK credential. An empty map would send
    // `only: []` with `byok: {}`, dropping BYOK pinning so inference bills Kilo's
    // Vercel account, while the request still counts as BYOK downstream and skips
    // the zero-balance rejection in the gateway route.
    const byokProviders =
      Object.keys(retainedByokProviders).length > 0 ? retainedByokProviders : allByokProviders;

    // Pass request-scoped credentials and restrict routing to the corresponding providers.
    requestToMutate.body.providerOptions = {
      gateway: {
        only: Object.keys(byokProviders),
        byok: byokProviders,
        models: requestToMutate.body.models,
      },
    };
  } else {
    const vercelInferenceProviders =
      await getCachedVercelInferenceProviderIdsForModel(vercelModelId);
    requestToMutate.body.providerOptions = convertProviderOptions(
      requestToMutate,
      vercelInferenceProviders
    );

    const gatewayOptions = requestToMutate.body.providerOptions.gateway;
    const openAiApiKey = getEnvVariable('OPENAI_API_KEY');
    // OpenAI BYOK must also be disabled in the Vercel GUI so this model uses Vercel's discounted endpoint.
    if (
      gatewayOptions &&
      openAiApiKey &&
      requestedModel !== gpt_5_6_sol_discounted_model.public_id &&
      vercelInferenceProviders?.includes('openai') &&
      (!gatewayOptions.only || gatewayOptions.only.includes('openai'))
    ) {
      gatewayOptions.byok = {
        ...gatewayOptions.byok,
        openai: [{ apiKey: openAiApiKey }],
      };
    }
  }

  if (requestToMutate.body.providerOptions) {
    const anthropicOptions = getAnthropicProviderOptionsForVercel(requestToMutate);
    if (anthropicOptions) {
      requestToMutate.body.providerOptions.anthropic = anthropicOptions;
    }
  }

  delete requestToMutate.body.provider;
  delete requestToMutate.body.models;
}

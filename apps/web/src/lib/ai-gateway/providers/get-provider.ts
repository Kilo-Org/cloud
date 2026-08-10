import type {
  GatewayRequest,
  OpenRouterProviderConfig,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { shouldRouteToVercel } from '@/lib/ai-gateway/providers/vercel';
import { findKiloExclusiveModel, isKiloExclusiveModel } from '@/lib/ai-gateway/models';
import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import {
  getBYOKforOrganization,
  getBYOKforUser,
  getModelUserByokProviders,
} from '@/lib/ai-gateway/byok';
import { custom_llm2, type User } from '@kilocode/db/schema';
import { readDb } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import type { AnonymousUserContext } from '@/lib/anonymous';
import { isAnonymousContext } from '@/lib/anonymous';
import type { BYOKResult, Provider } from '@/lib/ai-gateway/providers/types';
import {
  OPENROUTER,
  tryGetProviderById,
  VERCEL_AI_GATEWAY,
} from '@/lib/ai-gateway/providers/provider-definitions';
import {
  getDirectByokModel,
  getManualByokCredential,
} from '@/lib/ai-gateway/providers/direct-byok';
import { CustomLlmCredentialsSchema, CustomLlmDefinitionSchema } from '@kilocode/db/schema-types';
import { buildDirectProvider } from '@/lib/ai-gateway/experiments/build-direct-provider';
import { isPublicIdExperimented } from '@/lib/ai-gateway/experiments/membership';
import {
  pickModelExperimentVariant,
  type AllocationSubject,
} from '@/lib/ai-gateway/experiments/pick-variant';
import { getGoogleServiceAccountAccessToken } from '@/lib/ai-gateway/custom-llm/google-service-account';
import { userHasCustomLlmAccess } from '@/lib/ai-gateway/custom-llm/access';
import { decryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { addCacheBreakpoints } from '@/lib/ai-gateway/providers/openrouter/request-helpers';

/**
 * Metadata about the experiment that resolved this provider, attached when
 * routing chose a model_experiment_variant_version. Persisted in the
 * `model_experiment_request` row by Phase 4 attribution.
 */
export type ExperimentRouting = {
  experimentId: string;
  variantId: string;
  variantVersionId: string;
  allocationSubject: AllocationSubject;
};

export type GetProviderProviderResult = {
  kind: 'provider';
  provider: Provider;
  userByok: BYOKResult[] | null;
  /** Skip balance, paid-auth, and organization policy checks entirely. Used
   *  by direct-byok and custom_llm2 because both already require explicit
   *  admin opt-in. */
  bypassAccessCheck: boolean;
  /** Present when this provider was resolved through a model experiment. */
  experiment?: ExperimentRouting;
};

/**
 * Discriminated routing result. `not-found` maps to the local
 * model-unavailable response (used by paused experiments); `unavailable`
 * maps to a 503 temporarily-unavailable response (cache/DB/config failure).
 */
export type GetProviderResult =
  | GetProviderProviderResult
  | { kind: 'not-found' }
  | { kind: 'unavailable' };

async function checkDirectBYOK(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined
): Promise<GetProviderProviderResult | null> {
  const { provider: directByok, model: directByokModel } = await getDirectByokModel(requestedModel);
  if (!directByok || !directByokModel) {
    return null;
  }
  const userByok = organizationId
    ? await getBYOKforOrganization(readDb, organizationId, [directByok.id])
    : await getBYOKforUser(readDb, user.id, [directByok.id]);
  if (!userByok || userByok.length === 0) {
    return null;
  }
  return {
    kind: 'provider',
    provider: {
      id: 'direct-byok',
      apiUrl: directByok.base_url,
      apiUrlOverrides: directByok.base_url_overrides,
      apiKey: userByok[0].decryptedAPIKey,
      apiKeyHeader: null,
      supportedChatApis: directByok.supported_chat_apis,
      responseTransforms: null,
      async transformRequest(context) {
        context.request.body.model = directByokModel.id;
        directByok.transformRequest(context);
      },
    } satisfies Provider,
    userByok,
    bypassAccessCheck: true,
  };
}

async function checkManualBYOK(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined
): Promise<GetProviderProviderResult | null> {
  const credential = await getManualByokCredential(
    requestedModel,
    organizationId ? { organizationId } : { userId: user.id }
  );
  if (!credential) return null;
  return {
    kind: 'provider',
    provider: {
      id: 'direct-byok',
      apiUrl: credential.definition.base_url,
      apiUrlOverrides: {},
      apiKey: credential.byok.decryptedAPIKey,
      apiKeyHeader: credential.definition.use_x_api_key ? 'x-api-key' : null,
      supportedChatApis: credential.definition.supported_apis,
      responseTransforms: null,
      async transformRequest(context) {
        const body = context.request.body as Record<string, unknown>;
        for (const key of credential.definition.remove_from_body ?? []) delete body[key];
        Object.assign(body, credential.definition.extra_body ?? {});
        Object.assign(context.extraHeaders, credential.definition.extra_headers ?? {});
        context.request.body.model = credential.model.id;
        if (credential.resolvedModel.addCacheBreakpoints) {
          addCacheBreakpoints(context.request);
        }
      },
    },
    userByok: [credential.byok],
    bypassAccessCheck: true,
  };
}

async function checkCustomLlm(
  requestedModel: string,
  organizationId: string,
  kiloUserId: string
): Promise<GetProviderProviderResult | null> {
  const [row] = await readDb
    .select()
    .from(custom_llm2)
    .where(eq(custom_llm2.public_id, requestedModel));
  const parsedCustomLlm = CustomLlmDefinitionSchema.safeParse(row?.definition);
  if (row && !parsedCustomLlm.success) {
    console.log('Failed to parse custom llm definition', parsedCustomLlm.error);
  }
  const customLlm = parsedCustomLlm.data;
  if (!customLlm || !(await userHasCustomLlmAccess(customLlm, organizationId, kiloUserId))) {
    return null;
  }

  if (!row?.encrypted_api_key) {
    return null;
  }

  const decrypted = decryptApiKey(row.encrypted_api_key, BYOK_ENCRYPTION_KEY);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decrypted);
  } catch {
    return null;
  }
  const parsedCredentials = CustomLlmCredentialsSchema.safeParse(parsedJson);
  if (!parsedCredentials.success) {
    return null;
  }

  let apiKey: string;
  let apiKeyHeader: 'x-api-key' | null = null;
  if (parsedCredentials.data.type === 'api_key' || parsedCredentials.data.type === 'x-api-key') {
    apiKey = parsedCredentials.data.api_key;
    apiKeyHeader = parsedCredentials.data.type === 'x-api-key' ? 'x-api-key' : null;
  } else {
    apiKey = await getGoogleServiceAccountAccessToken(parsedCredentials.data);
  }

  const resolvedCustomLlm = {
    ...customLlm,
    api_key: apiKey,
  };
  return {
    kind: 'provider',
    provider: buildDirectProvider(
      'custom',
      [
        customLlm.opencode_settings?.ai_sdk_provider === 'anthropic'
          ? 'messages'
          : customLlm.opencode_settings?.ai_sdk_provider === 'openai'
            ? 'responses'
            : 'chat_completions',
      ],
      resolvedCustomLlm,
      apiKeyHeader
    ),
    userByok: null,
    bypassAccessCheck: true,
  };
}

async function checkVercelBYOK(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined
): Promise<BYOKResult[] | null> {
  if (isAnonymousContext(user)) return null;
  // Kilo-exclusive models are not routable through Vercel BYOK. Reasoning in particular
  // breaks: the Vercel AI Gateway normalizes reasoning to each provider's upstream-native
  // shape, whereas our Kilo-exclusive models are served through generic OpenAI-compatible
  // endpoints (Martian, direct Alibaba, etc.) where that normalization doesn't apply and the
  // response ends up corrupted. Skip the Vercel BYOK lookup entirely and let the caller fall
  // through to the model's declared gateway.
  if (isKiloExclusiveModel(requestedModel)) return null;
  const modelProviders = await getModelUserByokProviders(requestedModel);
  if (modelProviders.length === 0) return null;
  return organizationId
    ? getBYOKforOrganization(readDb, organizationId, modelProviders)
    : getBYOKforUser(readDb, user.id, modelProviders);
}

export type GetProviderInput = {
  requestedModel: string;
  request: GatewayRequest;
  user: User | AnonymousUserContext;
  organizationId: string | undefined;
  taskId: string | undefined;
  /** Resolved client IP from the route handler. Used as the IP-cohort
   *  allocation subject for experiment routing when no userId/machineId
   *  is available. */
  clientIp: string | null;
  /** Machine identifier from `x-kilocode-machineid`. Used as the machine-
   *  cohort allocation subject for experiment routing. */
  machineId: string | null;
  /** Resolves organization/group provider policy only when selecting a managed
   * gateway. Direct BYOK and custom LLM routes remain exempt. */
  getRoutingProviderConfig?: () => Promise<OpenRouterProviderConfig | undefined>;
};

export async function getProvider(input: GetProviderInput): Promise<GetProviderResult> {
  const {
    requestedModel,
    request,
    user,
    organizationId,
    taskId,
    clientIp,
    machineId,
    getRoutingProviderConfig,
  } = input;

  const manualByok = await checkManualBYOK(user, requestedModel, organizationId);
  if (manualByok) return manualByok;

  const directByokByok = await checkDirectBYOK(user, requestedModel, organizationId);
  if (directByokByok) {
    return directByokByok;
  }

  const vercelByok = await checkVercelBYOK(user, requestedModel, organizationId);
  if (vercelByok) {
    return {
      kind: 'provider',
      provider: VERCEL_AI_GATEWAY,
      userByok: vercelByok,
      bypassAccessCheck: false,
    };
  }

  const kiloExclusiveModel = findKiloExclusiveModel(requestedModel);

  // Model experiment routing for dedicated preview public ids. Runs before
  // the custom-LLM (`kilo-internal/...`) and the `kiloExclusiveModels` lookup
  // so an experimented public id never falls through to OpenRouter/Vercel.
  const experimented = await isPublicIdExperimented(requestedModel);
  if (experimented === true) {
    if (kiloExclusiveModel) {
      throw new Error(
        `Configuration error: ${requestedModel} cannot be both an experiment and a Kilo-exclusive model`
      );
    }
    const userId = isAnonymousContext(user) ? null : user.id;
    const selection = await pickModelExperimentVariant({
      publicModelId: requestedModel,
      userId,
      machineId,
      clientIp,
    });
    if (selection?.status === 'not-found') {
      return { kind: 'not-found' };
    }
    if (selection?.status === 'unavailable') {
      return { kind: 'unavailable' };
    }
    if (selection?.status === 'active') {
      return {
        kind: 'provider',
        provider: buildDirectProvider('experiment', ['chat_completions'], selection.upstream, null),
        userByok: null,
        bypassAccessCheck: false,
        experiment: {
          experimentId: selection.experimentId,
          variantId: selection.variantId,
          variantVersionId: selection.variantVersionId,
          allocationSubject: selection.allocationSubject,
        },
      };
    }
    // selection === null: cache+DB say no routing-relevant experiment for
    // this id. Fall through to non-experiment routing.
  }

  if (requestedModel.startsWith(CUSTOM_LLM_PREFIX) && organizationId && !isAnonymousContext(user)) {
    const customLlmResult = await checkCustomLlm(requestedModel, organizationId, user.id);
    if (customLlmResult) {
      return customLlmResult;
    }
  }

  const eligibleForVercelRouting =
    !kiloExclusiveModel || kiloExclusiveModel.flags.includes('vercel-routing');
  const resolveRoutingProviderConfig = async () =>
    (await getRoutingProviderConfig?.()) ?? request.body.provider;

  if (
    eligibleForVercelRouting &&
    (await shouldRouteToVercel(
      requestedModel,
      request,
      taskId || user.id,
      resolveRoutingProviderConfig
    ))
  ) {
    return {
      kind: 'provider',
      provider: VERCEL_AI_GATEWAY,
      userByok: null,
      bypassAccessCheck: false,
    };
  }

  return {
    kind: 'provider',
    provider: (kiloExclusiveModel && tryGetProviderById(kiloExclusiveModel.gateway)) ?? OPENROUTER,
    userByok: null,
    bypassAccessCheck: false,
  };
}

export async function getEmbeddingProvider(
  requestedModel: string,
  user: User | AnonymousUserContext,
  organizationId: string | undefined
): Promise<{ provider: Provider; userByok: BYOKResult[] | null }> {
  // 1. BYOK check — route through Vercel AI Gateway when user has their own key
  const userByok = await checkVercelBYOK(user, requestedModel, organizationId);
  if (userByok) {
    return { provider: VERCEL_AI_GATEWAY, userByok };
  }

  // 2. All non-BYOK embedding requests go through OpenRouter
  return { provider: OPENROUTER, userByok: null };
}

export async function getTranscriptionProvider(): Promise<{
  provider: Provider;
  userByok: BYOKResult[] | null;
}> {
  return { provider: OPENROUTER, userByok: null };
}

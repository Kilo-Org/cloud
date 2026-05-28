import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { shouldRouteToVercel } from '@/lib/ai-gateway/providers/vercel';
import { isKiloExclusiveModel, kiloExclusiveModels } from '@/lib/ai-gateway/models';
import {
  getBYOKforOrganization,
  getBYOKforUser,
  getModelUserByokProviders,
} from '@/lib/ai-gateway/byok';
import { custom_llm2, type User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import type { AnonymousUserContext } from '@/lib/anonymous';
import { isAnonymousContext } from '@/lib/anonymous';
import type { BYOKResult, Provider } from '@/lib/ai-gateway/providers/types';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { getDirectByokModel } from '@/lib/ai-gateway/providers/direct-byok';
import { CustomLlmDefinitionSchema } from '@kilocode/db';
import {
  buildDirectProvider,
  inferSupportedChatApis,
} from '@/lib/ai-gateway/experiments/build-direct-provider';
import { isPublicIdExperimented } from '@/lib/ai-gateway/experiments/membership';
import {
  pickModelExperimentVariant,
  type AllocationSubject,
} from '@/lib/ai-gateway/experiments/pick-variant';

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
  /** Skip pinning `body.provider` from the organization-determined config.
   *  Set for direct experiment upstreams where the partner endpoint is
   *  selected by the variant, not by gateway routing. */
  skipProviderPin?: boolean;
  /** Skip the kilo-exclusive `internal_id` rewrite + provider pin in
   *  `applyProviderSpecificLogic`. Generic provider-specific request fixes
   *  and `provider.transformRequest` still run. */
  skipKiloExclusiveModelSettings?: boolean;
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
    ? await getBYOKforOrganization(db, organizationId, [directByok.id])
    : await getBYOKforUser(db, user.id, [directByok.id]);
  if (!userByok || userByok.length === 0) {
    return null;
  }
  return {
    kind: 'provider',
    provider: {
      id: 'direct-byok',
      apiUrl: directByok.base_url,
      apiKey: userByok[0].decryptedAPIKey,
      supportedChatApis: inferSupportedChatApis(directByok.ai_sdk_provider),
      transformRequest(context) {
        context.request.body.model = directByokModel.id;
        directByok.transformRequest(context);
      },
    } satisfies Provider,
    userByok,
    bypassAccessCheck: true,
  };
}

async function checkCustomLlm(
  requestedModel: string,
  organizationId: string
): Promise<GetProviderProviderResult | null> {
  const [row] = await db
    .select()
    .from(custom_llm2)
    .where(eq(custom_llm2.public_id, requestedModel));
  const parsedCustomLlm = CustomLlmDefinitionSchema.safeParse(row?.definition);
  if (row && !parsedCustomLlm.success) {
    console.log('Failed to parse custom llm definition', parsedCustomLlm.error);
  }
  const customLlm = parsedCustomLlm.data;
  if (!customLlm || !customLlm.organization_ids.includes(organizationId)) {
    return null;
  }
  return {
    kind: 'provider',
    provider: buildDirectProvider({
      internal_id: customLlm.internal_id,
      base_url: customLlm.base_url,
      api_key: customLlm.api_key,
      opencode_settings: customLlm.opencode_settings
        ? { ai_sdk_provider: customLlm.opencode_settings.ai_sdk_provider }
        : undefined,
      extra_body: customLlm.extra_body,
      extra_headers: customLlm.extra_headers,
      remove_from_body: customLlm.remove_from_body,
      add_cache_breakpoints: customLlm.add_cache_breakpoints,
      inject_reasoning_into_content: customLlm.inject_reasoning_into_content,
    }),
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
    ? getBYOKforOrganization(db, organizationId, modelProviders)
    : getBYOKforUser(db, user.id, modelProviders);
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
};

export async function getProvider(input: GetProviderInput): Promise<GetProviderResult> {
  const { requestedModel, request, user, organizationId, taskId, clientIp, machineId } = input;

  const directByokByok = await checkDirectBYOK(user, requestedModel, organizationId);
  if (directByokByok) {
    return directByokByok;
  }

  const vercelByok = await checkVercelBYOK(user, requestedModel, organizationId);
  if (vercelByok) {
    return {
      kind: 'provider',
      provider: PROVIDERS.VERCEL_AI_GATEWAY,
      userByok: vercelByok,
      bypassAccessCheck: false,
    };
  }

  // Model experiment routing for dedicated preview public ids. Runs before
  // `kilo-internal/...` and the `kiloExclusiveModels` lookup so an
  // experimented public id never falls through to OpenRouter/Vercel.
  const experimented = await isPublicIdExperimented(requestedModel);
  if (experimented === true) {
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
        provider: buildDirectProvider(selection.upstream),
        userByok: null,
        bypassAccessCheck: false,
        skipProviderPin: true,
        skipKiloExclusiveModelSettings: true,
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

  if (requestedModel.startsWith('kilo-internal/') && organizationId) {
    const customLlmResult = await checkCustomLlm(requestedModel, organizationId);
    if (customLlmResult) {
      return customLlmResult;
    }
  }

  const kiloExclusiveModel = kiloExclusiveModels.find(m => m.public_id === requestedModel);
  const eligibleForVercelRouting =
    !kiloExclusiveModel || kiloExclusiveModel.flags.includes('vercel-routing');

  if (
    eligibleForVercelRouting &&
    (await shouldRouteToVercel(requestedModel, request, taskId || user.id))
  ) {
    return {
      kind: 'provider',
      provider: PROVIDERS.VERCEL_AI_GATEWAY,
      userByok: null,
      bypassAccessCheck: false,
    };
  }

  return {
    kind: 'provider',
    provider:
      Object.values(PROVIDERS).find(p => p.id === kiloExclusiveModel?.gateway) ??
      PROVIDERS.OPENROUTER,
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
    return { provider: PROVIDERS.VERCEL_AI_GATEWAY, userByok };
  }

  // 2. All non-BYOK embedding requests go through OpenRouter
  return { provider: PROVIDERS.OPENROUTER, userByok: null };
}

export async function getTranscriptionProvider(): Promise<{
  provider: Provider;
  userByok: BYOKResult[] | null;
}> {
  return { provider: PROVIDERS.OPENROUTER, userByok: null };
}

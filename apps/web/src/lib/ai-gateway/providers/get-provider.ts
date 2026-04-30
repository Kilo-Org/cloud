import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { shouldRouteToVercel } from '@/lib/ai-gateway/providers/vercel';
import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
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
import type { BYOKResult, GatewayChatApiKind, Provider } from '@/lib/ai-gateway/providers/types';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { getDirectByokModel } from '@/lib/ai-gateway/providers/direct-byok';
import {
  CustomLlmDefinitionSchema,
  type OpenClawApiAdapter,
  type CustomLlmProvider,
} from '@kilocode/db';
import {
  addCacheBreakpoints,
  injectReasoningIntoContent,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';

function inferSupportedChatApis(
  aiSdkProvider: CustomLlmProvider | undefined,
  openClawApiAdapter: OpenClawApiAdapter | undefined
): ReadonlyArray<GatewayChatApiKind> {
  const result = new Array<GatewayChatApiKind>();
  if (aiSdkProvider === 'openai' || openClawApiAdapter === 'openai-responses') {
    result.push('responses');
  }
  if (aiSdkProvider === 'anthropic' || openClawApiAdapter === 'anthropic-messages') {
    result.push('messages');
  }
  if (
    aiSdkProvider === 'openai-compatible' ||
    aiSdkProvider === 'alibaba' ||
    aiSdkProvider === 'openrouter' ||
    openClawApiAdapter === 'openai-completions' ||
    result.length === 0
  ) {
    result.push('chat_completions');
  }
  return result;
}

async function checkDirectBYOK(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined
) {
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
    provider: {
      id: 'direct-byok',
      apiUrl: directByok.base_url,
      apiKey: userByok[0].decryptedAPIKey,
      supportedChatApis: inferSupportedChatApis(directByok.ai_sdk_provider, undefined),
      transformRequest(context) {
        context.request.body.model = directByokModel.id;
        directByok.transformRequest(context);
      },
    } satisfies Provider,
    userByok,
    bypassAccessCheck: false,
  };
}

async function checkVercelBYOK(
  user: User | AnonymousUserContext,
  requestedModel: string,
  organizationId: string | undefined
): Promise<BYOKResult[] | null> {
  if (isAnonymousContext(user)) return null;
  const modelProviders = await getModelUserByokProviders(requestedModel);
  if (modelProviders.length === 0) return null;
  return organizationId
    ? getBYOKforOrganization(db, organizationId, modelProviders)
    : getBYOKforUser(db, user.id, modelProviders);
}

export async function getProvider(
  requestedModel: string,
  request: GatewayRequest,
  user: User | AnonymousUserContext,
  organizationId: string | undefined,
  taskId: string | undefined
): Promise<{ provider: Provider; userByok: BYOKResult[] | null; bypassAccessCheck: boolean }> {
  const directByokByok = await checkDirectBYOK(user, requestedModel, organizationId);
  if (directByokByok) {
    return directByokByok;
  }

  const vercelByok = await checkVercelBYOK(user, requestedModel, organizationId);
  if (vercelByok) {
    return {
      provider: PROVIDERS.VERCEL_AI_GATEWAY,
      userByok: vercelByok,
      bypassAccessCheck: false,
    };
  }

  if (requestedModel.startsWith('kilo-internal/') && organizationId) {
    const [row] = await db
      .select()
      .from(custom_llm2)
      .where(eq(custom_llm2.public_id, requestedModel));
    const parsedCustomLlm = CustomLlmDefinitionSchema.safeParse(row?.definition);
    if (row && !parsedCustomLlm.success) {
      console.log('Failed to parse custom llm definition', parsedCustomLlm.error);
    }
    const customLlm = parsedCustomLlm.data;
    if (customLlm && customLlm.organization_ids.includes(organizationId)) {
      return {
        provider: {
          id: 'custom',
          apiUrl: customLlm.base_url,
          apiKey: customLlm.api_key,
          supportedChatApis: inferSupportedChatApis(
            customLlm.opencode_settings?.ai_sdk_provider,
            customLlm.openclaw_settings?.api_adapter
          ),
          transformRequest(context) {
            if (customLlm.remove_from_body) {
              const body = context.request.body as Record<string, unknown>;
              for (const key of customLlm.remove_from_body ?? []) {
                delete body[key];
              }
            }
            Object.assign(context.request.body, customLlm.extra_body ?? {});
            Object.assign(context.extraHeaders, customLlm.extra_headers ?? {});
            context.request.body.model = customLlm.internal_id;
            if (customLlm.add_cache_breakpoints) {
              addCacheBreakpoints(context.request);
            }
            if (customLlm.inject_reasoning_into_content) {
              injectReasoningIntoContent(context.request);
            }
          },
        },
        userByok: null,
        bypassAccessCheck: true,
      };
    }
  }

  const kiloExclusiveModel = kiloExclusiveModels.find(m => m.public_id === requestedModel);
  const defaultProvider =
    Object.values(PROVIDERS).find(p => p.id === kiloExclusiveModel?.gateway) ??
    PROVIDERS.OPENROUTER;

  if (
    defaultProvider.id === 'openrouter' &&
    (await shouldRouteToVercel(requestedModel, request, taskId || user.id))
  ) {
    return { provider: PROVIDERS.VERCEL_AI_GATEWAY, userByok: null, bypassAccessCheck: false };
  }

  return {
    provider: defaultProvider,
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

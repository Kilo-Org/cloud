import 'server-only';
import { type db } from '@kilocode/web-shared/lib/drizzle';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  getEnabledByokProviders,
  getModelUserByokProviders,
  getOrganizationByokProviderIds,
  getUserByokProviderIds,
  type ByokOwner,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { hasEnabledUserByokForModel } from '@kilocode/web-shared/lib/ai-gateway/byok/availability';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { getAllowedDirectByokCatalogModelIds } from '@kilocode/web-shared/lib/ai-gateway/byok/organization-inference-provider-user-byok';
import {
  getDirectByokCatalogModelIds,
  getDirectByokModel,
  supportsCatalogMode,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getOpenAiChatGptCandidateModel } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import {
  getOpenAiChatGptStoredConnection,
  openAiChatGptSharedServicesOwner,
  type OpenAiChatGptOwner,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import { resolveClaudeBillingModel } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/routing';
import {
  getGrantedClaudeBillingConnection,
  type ClaudeBillingOwner,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import {
  resolveOrganizationMemberModelDecision,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import type { User } from '@kilocode/db/schema';

export type BalanceCheckModelEligibility = {
  isFree: boolean;
  hasUserByokAvailable: boolean;
};

/**
 * Decide whether `prepareSession` should skip the worker-side $1 balance
 * minimum for the chosen model.
 *
 * Skips the check when either:
 * - the model is Kilo-funded (free for the user), or
 * - the user has a BYOK credential that serves it: a Vercel-routed inference
 *   provider key, a gateway key, a direct BYOK key (bespoke or catalog mode),
 *   a "Sign in with ChatGPT" connection, or a Claude billing link, so the
 *   session is billed against the user's own key, plan, or Claude organization
 *   rather than their balance.
 */
export async function computeCloudAgentNextBalanceCheckEligibility(params: {
  fromDb: typeof db;
  user: Pick<User, 'id'>;
  modelId: string;
  organizationId?: string;
  includeSharedServicesConnection?: boolean;
}): Promise<BalanceCheckModelEligibility> {
  // Naming a custom LLM the user cannot call skips this check too, but the
  // gateway refuses every request for it, so the session cannot run inference.
  if (isFreeModel(params.modelId)) {
    return { isFree: true, hasUserByokAvailable: false };
  }

  const enabledProviderIds = params.organizationId
    ? await getOrganizationByokProviderIds(params.fromDb, params.organizationId)
    : await getUserByokProviderIds(params.fromDb, params.user.id);
  if (enabledProviderIds.length === 0) {
    return {
      isFree: false,
      hasUserByokAvailable:
        (await hasOpenAiChatGptByokForModel(params)) || (await hasClaudeBillingForModel(params)),
    };
  }

  const enabled = new Set(enabledProviderIds);
  const modelProviders = await getModelUserByokProviders(params.modelId, enabled);
  // Callers authorize organization access first, which also admits Kilo admins
  // and parent-organization owners who hold no membership row.
  const memberDecision = params.organizationId
    ? await resolveOrganizationMemberModelDecision({
        organizationId: params.organizationId,
        kiloUserId: params.user.id,
        allowNonMember: true,
        modelId: params.modelId,
      })
    : undefined;
  const decision = memberDecision?.decision;
  // Like routing, a denial leaves no allowed provider for the model.
  const allowedProviders = decision
    ? decision.allowed
      ? decision.eligibleProviderRoutes
      : new Set<string>()
    : undefined;
  const hasUserByokAvailable = await hasEnabledUserByokForModel({
    modelId: params.modelId,
    modelProviders,
    enabledProviderIds: enabled,
    allowedProviders,
  });
  const hasByokAvailable =
    hasUserByokAvailable ||
    (await hasDirectByokForModel({
      fromDb: params.fromDb,
      owner: params.organizationId
        ? { type: 'organization', id: params.organizationId }
        : { type: 'user', id: params.user.id },
      enabledProviderIds: enabled,
      modelId: params.modelId,
      policy: memberDecision?.policy,
    }));
  return {
    isFree: false,
    hasUserByokAvailable:
      hasByokAvailable ||
      (await hasOpenAiChatGptByokForModel(params)) ||
      (await hasClaudeBillingForModel(params)),
  };
}

/**
 * Whether a direct BYOK key serves `modelId`, as `getProvider` routes it: a
 * bespoke `<provider>/<model>` id to that provider's enabled key unless the key
 * is in catalog mode, or a catalog id to a catalog-mode key. Organization
 * catalog ids also pass the provider allow-list.
 */
async function hasDirectByokForModel(params: {
  fromDb: typeof db;
  owner: ByokOwner;
  enabledProviderIds: ReadonlySet<string>;
  modelId: string;
  policy?: EffectiveOrganizationModelPolicy;
}): Promise<boolean> {
  const modelId = params.modelId.toLowerCase();
  // Routing serves a custom LLM before any direct BYOK route, so no key serves
  // an id a custom LLM owns.
  if (await isCustomLlm(modelId)) return false;
  const { provider, model } = await getDirectByokModel(modelId);
  if (provider && model) {
    const enabledProviders = await getEnabledByokProviders(params.fromDb, params.owner);
    const key = enabledProviders.find(enabled => enabled.providerId === provider.id);
    return key !== undefined && !(key.serveCatalogModels && supportsCatalogMode(provider.id));
  }

  if (![...params.enabledProviderIds].some(providerId => supportsCatalogMode(providerId))) {
    return false;
  }
  const catalogModelIds =
    params.owner.type === 'organization' && params.policy
      ? await getAllowedDirectByokCatalogModelIds(params.owner.id, params.policy)
      : await getDirectByokCatalogModelIds(params.owner);
  return catalogModelIds.has(modelId);
}

/**
 * Whether a "Sign in with ChatGPT" connection serves the model, so the ChatGPT
 * plan pays instead of the Kilo balance. Service runs also consider the
 * organization's shared-services connection, which routing tries first.
 */
async function hasOpenAiChatGptByokForModel(params: {
  user: Pick<User, 'id'>;
  modelId: string;
  organizationId?: string;
  includeSharedServicesConnection?: boolean;
}): Promise<boolean> {
  if (!(await getOpenAiChatGptCandidateModel('responses', params.modelId))) return false;

  const owners: OpenAiChatGptOwner[] = [];
  if (params.includeSharedServicesConnection && params.organizationId) {
    owners.push(openAiChatGptSharedServicesOwner(params.organizationId));
  }
  owners.push({ kiloUserId: params.user.id, organizationId: params.organizationId ?? null });

  for (const owner of owners) {
    const stored = await getOpenAiChatGptStoredConnection(owner);
    if (stored?.isEnabled && stored.connection.status === 'connected') return true;
  }
  return false;
}

/**
 * Whether a Claude billing link serves the model, so the customer's Claude
 * organization pays instead of the Kilo balance. The candidates and their
 * order match `checkClaudeBilling`: the first link that is neither absent,
 * pending, nor removed decides, and one that cannot bill fails the request.
 */
async function hasClaudeBillingForModel(params: {
  fromDb: typeof db;
  user: Pick<User, 'id'>;
  modelId: string;
  organizationId?: string;
  includeSharedServicesConnection?: boolean;
}): Promise<boolean> {
  if (!(await resolveClaudeBillingModel(params.modelId))) return false;

  const owners: ClaudeBillingOwner[] = [];
  if (params.includeSharedServicesConnection && params.organizationId) {
    owners.push({ kind: 'shared_services', organizationId: params.organizationId });
  }
  owners.push(
    params.organizationId
      ? { kind: 'member', kiloUserId: params.user.id, organizationId: params.organizationId }
      : { kind: 'personal', kiloUserId: params.user.id }
  );

  for (const owner of owners) {
    const row = await getGrantedClaudeBillingConnection(owner, params.fromDb);
    if (row?.status === ClaudeBillingConnectionStatus.Connected) return true;
    if (row?.status === ClaudeBillingConnectionStatus.BillingUnavailable) return false;
  }
  return false;
}

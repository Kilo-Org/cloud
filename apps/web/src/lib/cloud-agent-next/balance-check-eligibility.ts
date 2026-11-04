import 'server-only';
import { type db } from '@kilocode/web-shared/lib/drizzle';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  getModelUserByokProviders,
  getOrganizationByokProviderIds,
  getUserByokProviderIds,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { hasEnabledUserByokForModel } from '@kilocode/web-shared/lib/ai-gateway/byok/availability';
import { getOpenAiChatGptCandidateModel } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import {
  getOpenAiChatGptStoredConnection,
  openAiChatGptSharedServicesOwner,
  type OpenAiChatGptOwner,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
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
 * - the user has a BYOK provider configured that can serve it, or a "Sign in
 *   with ChatGPT" connection that serves it, so the session is billed against
 *   the user's own key or plan rather than their balance.
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
    return { isFree: false, hasUserByokAvailable: await hasOpenAiChatGptByokForModel(params) };
  }

  const enabled = new Set(enabledProviderIds);
  const modelProviders = await getModelUserByokProviders(params.modelId, enabled);
  // Callers authorize organization access first, which also admits Kilo admins
  // and parent-organization owners who hold no membership row.
  const decision = params.organizationId
    ? (
        await resolveOrganizationMemberModelDecision({
          organizationId: params.organizationId,
          kiloUserId: params.user.id,
          allowNonMember: true,
          modelId: params.modelId,
        })
      ).decision
    : undefined;
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
  return {
    isFree: false,
    hasUserByokAvailable: hasUserByokAvailable || (await hasOpenAiChatGptByokForModel(params)),
  };
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

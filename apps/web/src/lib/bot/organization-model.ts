import { TRPCError } from '@trpc/server';
import {
  getEffectiveModelDecision,
  resolveOrganizationDefaultModelPolicy,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { DEFAULT_BOT_MODEL } from './constants';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';

/**
 * The organization's default-policy decision for one model, or `undefined` when
 * the organization row is missing or deleted. The settings write path
 * (`isOrganizationModelUpdateAllowed`) treats that case as allowed, and the bot
 * path keeps the same rule here.
 */
async function defaultModelDecision(
  organizationId: string,
  modelId: string
): Promise<{ policy: EffectiveOrganizationModelPolicy; allowed: boolean } | undefined> {
  try {
    // One policy resolution serves both the stored model's decision and, when it
    // is denied, the default lookup below.
    const policy = await resolveOrganizationDefaultModelPolicy({ organizationId });
    return { policy, allowed: (await getEffectiveModelDecision(policy, modelId)).allowed };
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

/**
 * The model an organization bot runs on for one message: the stored slug while
 * the organization's current policy allows it, otherwise the organization's
 * allowed default (its own default model when allowed, else the bot default).
 * Reads the same organization policy that `updateModel` enforces at write time,
 * so a policy change applies to the next message without waiting for the setting
 * to be saved again.
 *
 * A user-owned integration (no organization id) keeps its stored model. The bot
 * default is exempt from the policy, so the result is always a model.
 */
export async function resolveOrganizationBotModel(params: {
  organizationId: string | null | undefined;
  storedModelSlug: string;
}): Promise<string> {
  const { organizationId, storedModelSlug } = params;
  if (!organizationId) return storedModelSlug;

  const resolved = await defaultModelDecision(organizationId, storedModelSlug);
  if (!resolved || resolved.allowed) return storedModelSlug;

  return (
    (await getDefaultAllowedModel(organizationId, DEFAULT_BOT_MODEL, resolved.policy)) ??
    DEFAULT_BOT_MODEL
  );
}

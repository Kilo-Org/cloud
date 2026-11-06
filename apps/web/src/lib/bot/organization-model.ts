import { DEFAULT_BOT_MODEL } from './constants';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { isOrganizationModelUpdateAllowed } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

/**
 * The model an organization bot runs on for one message: the stored slug while
 * the organization's current policy still allows it, otherwise the org's
 * allowed default. Reads the same organization policy that `updateModel`
 * enforces at write time, so a policy change applies to the next message
 * without waiting for the setting to be saved again.
 *
 * `null` means the policy allows no model the bot can use: callers refuse the
 * run instead of substituting a model the organization has not chosen. A
 * user-owned integration (no organization id) keeps its stored model.
 *
 * A missing organization row counts as policy-allowed, mirroring
 * `isOrganizationModelUpdateAllowed`, which the write path already uses.
 */
export async function resolveOrganizationBotModel(params: {
  organizationId: string | null | undefined;
  storedModelSlug: string;
}): Promise<string | null> {
  const { organizationId, storedModelSlug } = params;
  if (!organizationId) return storedModelSlug;
  if (await isOrganizationModelUpdateAllowed(organizationId, storedModelSlug)) {
    return storedModelSlug;
  }
  return await getDefaultAllowedModel(organizationId, DEFAULT_BOT_MODEL);
}

import { PRIMARY_DEFAULT_MODEL, preferredModels } from '@/lib/ai-gateway/models';
import { getOrganizationById } from '@/lib/organizations/organizations';
import {
  getEffectiveModelDecision,
  resolveOrganizationDefaultModelPolicy,
} from '@/lib/organizations/effective-model-access.server';

/**
 * Get a default model that is allowed for an organization.
 * Priority: org default model > global default > preferred models > global default fallback.
 */
export async function getDefaultAllowedModel(
  organizationId: string,
  globalDefault = PRIMARY_DEFAULT_MODEL
): Promise<string> {
  const organization = await getOrganizationById(organizationId);
  if (!organization) {
    return globalDefault;
  }

  // Resolve the organization's default policy once. When it imposes no
  // restriction (non-Enterprise, or an unrestricted grant with no deny list and
  // no provider ceiling), every candidate is allowed, so skip the per-model
  // checks and preserve the "no restrictions → global default" fast path.
  const policy = await resolveOrganizationDefaultModelPolicy({ organizationId });
  const isUnrestricted =
    policy.memberGrant.mode === 'unrestricted' &&
    policy.organizationModelDenyList.length === 0 &&
    !policy.organizationProviderCeiling;
  if (isUnrestricted) {
    return organization.settings?.default_model || globalDefault;
  }

  const isAllowed = async (modelId: string) =>
    (await getEffectiveModelDecision(policy, modelId)).allowed;

  // Check if the organization's default model is allowed
  const orgDefaultModel = organization.settings?.default_model;
  if (orgDefaultModel && (await isAllowed(orgDefaultModel))) {
    return orgDefaultModel;
  }

  if (globalDefault && (await isAllowed(globalDefault))) {
    return globalDefault;
  }

  // Try each preferred/recommended model in order
  for (const model of preferredModels) {
    if (await isAllowed(model)) {
      return model;
    }
  }

  // All models were blocked; fall back to global default
  console.warn('[SlackBot] No allowed model found; org policy blocks all preferred models');
  return globalDefault;
}

import { PRIMARY_DEFAULT_MODEL } from '@kilocode/web-shared/lib/ai-gateway/models';
import { getPreferredModels } from '@kilocode/web-shared/lib/ai-gateway/preferred-models';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  getEffectiveModelDecision,
  resolveOrganizationDefaultModelPolicy,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';

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
  // no provider ceiling), return `globalDefault` exactly as the pre-policy code
  // did. The organization's own `default_model` is only consulted on the
  // restricted path below, after `isAllowed` accepts it, because it may hold a
  // non-routable virtual id such as `organization-auto`.
  const policy = await resolveOrganizationDefaultModelPolicy({ organizationId });
  const isUnrestricted =
    policy.memberGrant.mode === 'unrestricted' &&
    policy.organizationModelDenyList.length === 0 &&
    !policy.organizationProviderCeiling;
  if (isUnrestricted) {
    return globalDefault;
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
  for (const model of await getPreferredModels()) {
    if (await isAllowed(model)) {
      return model;
    }
  }

  // All models were blocked; fall back to global default
  console.warn('[SlackBot] No allowed model found; org policy blocks all preferred models');
  return globalDefault;
}

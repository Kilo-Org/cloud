import { PRIMARY_DEFAULT_MODEL, preferredModels } from '@/lib/ai-gateway/models';
import { getOrganizationById } from '@/lib/organizations/organizations';
import {
  getEffectiveModelDecision,
  resolveOrganizationDefaultModelPolicy,
} from '@/lib/organizations/effective-model-access.server';
import { getModelIdToProviderSlugsIndex } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

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
  // restriction (non-Enterprise with an unrestricted grant), return
  // `globalDefault` exactly as the pre-policy code did. The organization's own
  // `default_model` is only consulted on the restricted path below, after
  // `isAllowed` accepts it, because it may hold a non-routable virtual id such
  // as `organization-auto`.
  const policy = await resolveOrganizationDefaultModelPolicy({ organizationId });
  const isUnrestricted =
    policy.memberGrant.mode === 'unrestricted' &&
    policy.organizationModelDenyList.length === 0 &&
    !policy.organizationProviderCeiling &&
    !policy.requireModelInCurrentSnapshot;
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
  for (const model of preferredModels) {
    if (await isAllowed(model)) {
      return model;
    }
  }

  const providerIndex = await getModelIdToProviderSlugsIndex();
  for (const modelId of providerIndex.keys()) {
    if (await isAllowed(modelId)) {
      return modelId;
    }
  }

  throw new Error('No allowed default model is available for this organization');
}

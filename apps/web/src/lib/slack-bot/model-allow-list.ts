import { PRIMARY_DEFAULT_MODEL } from '@kilocode/web-shared/lib/ai-gateway/models';
import { getPreferredModels } from '@kilocode/web-shared/lib/ai-gateway/preferred-models';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  getEffectiveModelDecision,
  resolveOrganizationDefaultModelPolicy,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

/**
 * Get a default model that is allowed for an organization, or `null` when the
 * organization's model-access policy allows none of the candidates. Callers must
 * treat `null` as "no model configured" and store no model for it.
 * Priority: org default model > global default > preferred models.
 *
 * A caller that already resolved the organization's default policy passes it in,
 * so one decision path does not resolve the same policy twice.
 */
export async function getDefaultAllowedModel(
  organizationId: string,
  globalDefault = PRIMARY_DEFAULT_MODEL,
  policy?: EffectiveOrganizationModelPolicy
): Promise<string | null> {
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
  const resolvedPolicy =
    policy ?? (await resolveOrganizationDefaultModelPolicy({ organizationId }));
  const isUnrestricted =
    resolvedPolicy.memberGrant.mode === 'unrestricted' &&
    resolvedPolicy.organizationModelDenyList.length === 0 &&
    !resolvedPolicy.organizationProviderCeiling;
  if (isUnrestricted) {
    return globalDefault;
  }

  const isAllowed = async (modelId: string) =>
    (await getEffectiveModelDecision(resolvedPolicy, modelId)).allowed;

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

  // No candidate passed `isAllowed`: the policy allows none of them, so there is
  // no default model to return. This is the contract's no-model result; the
  // install paths pass the policy-exempt bot default, so they resolve that model
  // and this branch is reached through the resolver's own default argument.
  console.warn('[SlackBot] No allowed model found; org policy blocks all preferred models');
  return null;
}

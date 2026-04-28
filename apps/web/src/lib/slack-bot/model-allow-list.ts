import { PRIMARY_DEFAULT_MODEL, preferredModels } from '@/lib/ai-gateway/models';
import { getOrganizationById } from '@/lib/organizations/organizations';
import {
  createAllowPredicateFromRestrictions,
  hasActiveModelRestrictions,
} from '@/lib/model-allow.server';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';

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

  const restrictions = getEffectiveModelRestrictions(organization);

  // If no restrictions, use global default
  if (!hasActiveModelRestrictions(restrictions)) {
    return globalDefault;
  }

  const isAllowed = createAllowPredicateFromRestrictions(restrictions);

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

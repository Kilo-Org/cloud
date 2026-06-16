import type { Organization } from '@kilocode/db/schema';
import type { OrganizationAutoModelSettings } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { createAllowPredicateFromRestrictions } from '@/lib/model-allow.server';
import { CUSTOM_LLM_PREFIX, normalizeModelId } from '@/lib/ai-gateway/model-utils';
import {
  formatDirectByokModelId,
  getDirectByokModel,
} from '@/lib/ai-gateway/providers/direct-byok';
import { getBYOKforOrganization } from '@/lib/ai-gateway/byok';
import { db } from '@/lib/drizzle';
import {
  KILO_AUTO_BALANCED_MODEL,
  ORGANIZATION_AUTO_TARGET_MODELS,
  ORG_AUTO_MODEL,
} from '@/lib/ai-gateway/auto-model';

type OrganizationAutoPolicyOrganization = Pick<Organization, 'id' | 'plan' | 'settings'>;

export const ORGANIZATION_AUTO_MODEL_FLAG = 'organization-auto-model-routing';

export const DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS: OrganizationAutoModelSettings = {
  routes: {},
  fallback_model: KILO_AUTO_BALANCED_MODEL.id,
};

export function isOrganizationAutoEligible(organization: Organization): boolean {
  return organization.plan === 'enterprise';
}

export function isOrganizationAutoConfigured(organization: Organization): boolean {
  return isOrganizationAutoEligible(organization) && !!organization.settings.org_auto_model;
}

export function isOrganizationAutoEnabled(organization: Organization): boolean {
  return (
    isOrganizationAutoConfigured(organization) &&
    organization.settings.default_model === ORG_AUTO_MODEL.id
  );
}

export function getOrganizationAutoSettings(
  organization: Organization
): OrganizationAutoModelSettings | undefined {
  return organization.settings.org_auto_model;
}

export function getOrganizationAutoRoute(
  settings: Organization['settings'] | undefined,
  slug: string
): string | undefined {
  if (!settings?.org_auto_model) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(settings.org_auto_model.routes, slug)) {
    return undefined;
  }
  return settings.org_auto_model.routes[slug];
}

export function isOrganizationAutoTargetModel(modelId: string): boolean {
  return (ORGANIZATION_AUTO_TARGET_MODELS as readonly string[]).includes(modelId);
}

export type OrganizationAutoTargetValidationResult =
  | { kind: 'ok'; modelId: string }
  | { kind: 'error'; message: string };

export async function validateOrganizationAutoTarget(
  organization: OrganizationAutoPolicyOrganization,
  targetModelId: string,
  options: { apiKind?: 'chat_completions' | 'responses' | 'messages' } = {}
): Promise<OrganizationAutoTargetValidationResult> {
  const rawModelId = targetModelId.trim().toLowerCase();
  const normalizedModelId = normalizeModelId(rawModelId);

  if (!rawModelId) {
    return { kind: 'error', message: 'Organization Auto route target is required.' };
  }

  if (normalizedModelId.endsWith('/*')) {
    return {
      kind: 'error',
      message: `Organization Auto route target '${targetModelId}' is not a concrete model identifier.`,
    };
  }

  if (normalizedModelId === ORG_AUTO_MODEL.id) {
    return { kind: 'error', message: 'Organization Auto cannot target itself.' };
  }

  if (rawModelId.startsWith(CUSTOM_LLM_PREFIX)) {
    return {
      kind: 'error',
      message: `Organization Auto route target '${targetModelId}' must be a Kilo-hosted model, supported auto tier, or organization-owned BYOK model.`,
    };
  }

  const directByokTarget = await getDirectByokModel(rawModelId);
  if (directByokTarget.provider && directByokTarget.model) {
    const byok = await getBYOKforOrganization(db, organization.id, [directByokTarget.provider.id]);
    if (!byok || byok.length === 0) {
      return {
        kind: 'error',
        message: `Organization Auto route target '${targetModelId}' is unavailable because this organization does not have an enabled BYOK credential for ${directByokTarget.provider.id}.`,
      };
    }
    if (
      options.apiKind &&
      !directByokTarget.provider.supported_chat_apis.includes(options.apiKind)
    ) {
      return {
        kind: 'error',
        message: `Organization Auto route target '${targetModelId}' does not support the ${options.apiKind} API.`,
      };
    }
    return {
      kind: 'ok',
      modelId: formatDirectByokModelId(directByokTarget.provider, directByokTarget.model),
    };
  }

  if (normalizedModelId.startsWith('kilo-auto/')) {
    if (!isOrganizationAutoTargetModel(normalizedModelId)) {
      return {
        kind: 'error',
        message: `Organization Auto route target '${targetModelId}' is not a supported auto tier.`,
      };
    }

    return { kind: 'ok', modelId: normalizedModelId };
  }

  let models;
  try {
    models = await getEnhancedOpenRouterModels();
  } catch {
    return {
      kind: 'error',
      message:
        'Organization Auto could not validate this route target against the current model catalog.',
    };
  }
  if (!models.data.some(model => normalizeModelId(model.id) === normalizedModelId)) {
    return {
      kind: 'error',
      message: `Organization Auto route target '${targetModelId}' is unavailable.`,
    };
  }

  const isAllowed = createAllowPredicateFromRestrictions({
    providerAllowList:
      organization.plan === 'enterprise' ? organization.settings.provider_allow_list : undefined,
    modelDenyList:
      organization.plan === 'enterprise' ? (organization.settings.model_deny_list ?? []) : [],
  });
  if (!(await isAllowed(normalizedModelId))) {
    return {
      kind: 'error',
      message: `Organization Auto route target '${targetModelId}' is not allowed by the organization's model policy.`,
    };
  }

  return { kind: 'ok', modelId: normalizedModelId };
}

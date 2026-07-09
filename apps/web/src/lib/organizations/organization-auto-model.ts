import type { Organization } from '@kilocode/db/schema';
import type { OrganizationAutoModelSettings } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import {
  createAllowPredicateFromRestrictions,
  hasActiveModelRestrictions,
} from '@/lib/model-allow.server';
import { CUSTOM_LLM_PREFIX, normalizeModelId } from '@/lib/ai-gateway/model-utils';
import {
  formatDirectByokModelId,
  getDirectByokModel,
} from '@/lib/ai-gateway/providers/direct-byok';
import { getBYOKforOrganization } from '@/lib/ai-gateway/byok';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { KILO_AUTO_BALANCED_MODEL, ORG_AUTO_MODEL } from '@/lib/ai-gateway/auto-model';
import { isPublicIdExperimented } from '@/lib/ai-gateway/experiments/membership';
import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';
import { TRPCError } from '@trpc/server';
export {
  getOrganizationAutoRoute,
  hasOrganizationAutoRoute,
  isOrganizationAutoTargetModel,
  MAX_ORGANIZATION_AUTO_ROUTES,
  ORGANIZATION_AUTO_MODEL_FLAG,
} from '@/lib/organizations/organization-auto-model-shared';
import {
  isOrganizationAutoTargetModel,
  ORGANIZATION_AUTO_MODEL_FLAG,
} from '@/lib/organizations/organization-auto-model-shared';

type OrganizationAutoPolicyOrganization = Pick<Organization, 'id' | 'plan' | 'settings'>;

export const DEFAULT_ORGANIZATION_AUTO_MODEL_SETTINGS: OrganizationAutoModelSettings = {
  routes: {},
  fallback_model: KILO_AUTO_BALANCED_MODEL.id,
};

export function isOrganizationAutoEligible(organization: Pick<Organization, 'plan'>): boolean {
  return organization.plan === 'enterprise';
}

// The rollout is actor-scoped so flagged admins can configure eligible organizations early.
export async function assertOrganizationAutoWriteEnabled(userId: string): Promise<void> {
  if (
    process.env.NODE_ENV !== 'development' &&
    !(await isReleaseToggleEnabled(ORGANIZATION_AUTO_MODEL_FLAG, userId))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Organization Auto configuration is not available',
    });
  }
}

export function assertOrganizationAutoEligible(organization: Pick<Organization, 'plan'>): void {
  if (!isOrganizationAutoEligible(organization)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Organization Auto is only available for Enterprise organizations.',
    });
  }
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

export type OrganizationAutoTargetValidationResult =
  | { kind: 'ok'; modelId: string }
  | { kind: 'error'; message: string };

export async function validateOrganizationAutoTarget(
  organization: OrganizationAutoPolicyOrganization,
  targetModelId: string,
  options: {
    apiKind?: 'chat_completions' | 'responses' | 'messages';
    dbClient?: typeof db | DrizzleTransaction;
  } = {}
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
    const byok = await getBYOKforOrganization(options.dbClient ?? db, organization.id, [
      directByokTarget.provider.id,
    ]);
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

  const restrictions = {
    providerAllowList:
      organization.plan === 'enterprise' ? organization.settings.provider_allow_list : undefined,
    modelDenyList:
      organization.plan === 'enterprise' ? (organization.settings.model_deny_list ?? []) : [],
  };

  if (normalizedModelId.startsWith('kilo-auto/')) {
    if (!isOrganizationAutoTargetModel(normalizedModelId)) {
      return {
        kind: 'error',
        message: `Organization Auto route target '${targetModelId}' is not a supported auto tier.`,
      };
    }

    if (hasActiveModelRestrictions(restrictions)) {
      return {
        kind: 'error',
        message: `Organization Auto route target '${targetModelId}' cannot use an auto tier while the organization has an active model policy. Choose a concrete allowed model instead.`,
      };
    }

    return { kind: 'ok', modelId: normalizedModelId };
  }

  if (await isPublicIdExperimented(normalizedModelId)) {
    return {
      kind: 'error',
      message: `Organization Auto route target '${targetModelId}' cannot use an active model experiment. Choose a concrete production model instead.`,
    };
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
  const catalogModel = models.data.find(model => model.id.toLowerCase() === rawModelId);
  if (!catalogModel) {
    return {
      kind: 'error',
      message: `Organization Auto route target '${targetModelId}' is unavailable.`,
    };
  }

  const isAllowed = createAllowPredicateFromRestrictions(restrictions);
  if (!(await isAllowed(normalizedModelId))) {
    return {
      kind: 'error',
      message: `Organization Auto route target '${targetModelId}' is not allowed by the organization's model policy.`,
    };
  }

  return { kind: 'ok', modelId: catalogModel.id };
}

import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import { ORGANIZATION_AUTO_TARGET_MODELS } from '@/lib/ai-gateway/auto-model';

export const ORGANIZATION_AUTO_MODEL_FLAG = 'organization-auto-model-routing';
export const MAX_ORGANIZATION_AUTO_ROUTES = 100;

export function getOrganizationAutoRoute(
  settings: OrganizationSettings | undefined,
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

export function hasActiveOrganizationModelPolicy(
  settings: OrganizationSettings | undefined
): boolean {
  return (
    settings?.provider_allow_list !== undefined || (settings?.model_deny_list?.length ?? 0) > 0
  );
}

import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import { ORGANIZATION_AUTO_TARGET_MODELS } from '@/lib/ai-gateway/auto-model';
export { MAX_ORGANIZATION_AUTO_ROUTES } from '@kilocode/db/schema-types';

export const ORGANIZATION_AUTO_MODEL_FLAG = 'organization-auto-model-routing';

export function hasOrganizationAutoRoute(
  routes: Record<string, string> | undefined,
  slug: string
): boolean {
  return !!routes && Object.prototype.hasOwnProperty.call(routes, slug);
}

export function getOrganizationAutoRoute(
  settings: OrganizationSettings | undefined,
  slug: string
): string | undefined {
  const routes = settings?.org_auto_model?.routes;
  if (!hasOrganizationAutoRoute(routes, slug)) {
    return undefined;
  }
  return routes?.[slug];
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

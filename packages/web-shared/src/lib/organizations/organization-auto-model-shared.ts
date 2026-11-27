import {
  parseCustomRouterModelId,
  type CustomRouterReference,
} from '@kilocode/auto-routing-contracts';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import { ORGANIZATION_AUTO_TARGET_MODELS } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
export { MAX_ORGANIZATION_AUTO_ROUTES } from '@kilocode/db/schema-types';

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
  return ORGANIZATION_AUTO_TARGET_MODELS.includes(modelId);
}

/** The org-scoped custom router reference an Organization Auto target names, or null (ADR 0005). */
export function organizationCustomRouterTargetReference(
  modelId: string
): CustomRouterReference | null {
  const reference = parseCustomRouterModelId(modelId);
  return reference?.scope === 'org' ? reference : null;
}

// Organization Auto may route to the organization's own custom routers, never to a member's
// personal router (ADR 0005).
export function isOrganizationCustomRouterTarget(modelId: string): boolean {
  return organizationCustomRouterTargetReference(modelId) !== null;
}

export function hasActiveOrganizationModelPolicy(
  settings: OrganizationSettings | undefined
): boolean {
  // The `disable_new_models` policy fills the deny list on its own, so under it a deny list
  // does not rule out auto tiers; see `validateOrganizationAutoTarget`.
  return (
    settings?.provider_allow_list !== undefined ||
    ((settings?.model_deny_list?.length ?? 0) > 0 && settings?.disable_new_models !== true)
  );
}

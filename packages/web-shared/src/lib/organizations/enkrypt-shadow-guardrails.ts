import { ENKRYPT_SHADOW_GUARDRAILS_ORGANIZATION_IDS } from '@kilocode/web-shared/lib/organizations/constants';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';

export function isEnkryptShadowGuardrailsOrganization(
  organizationId: string | null | undefined
): boolean {
  return !!organizationId && ENKRYPT_SHADOW_GUARDRAILS_ORGANIZATION_IDS.has(organizationId);
}

export function isEnkryptShadowGuardrailsEnabled(
  organizationId: string | null | undefined,
  settings: OrganizationSettings | null | undefined
): boolean {
  return (
    isEnkryptShadowGuardrailsOrganization(organizationId) &&
    settings?.enkrypt_shadow_guardrails_enabled === true
  );
}

import type { OrganizationSettings } from '@kilocode/db/schema-types';

/**
 * Whether Kilo admins granted the organization the AI Guardrails page and dashboard card
 * (`settings.kilo_encrypt`). Off unless explicitly enabled.
 */
export function isKiloEncryptEnabled(settings: OrganizationSettings | null | undefined): boolean {
  return settings?.kilo_encrypt === true;
}

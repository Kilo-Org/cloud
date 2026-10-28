import 'server-only';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';

/** Organization-scoped PostHog flag for the AI Guardrails page, dashboard card, and procedures. */
export const KILO_ENCRYPT_FLAG = 'kilo_encrypt';

/**
 * Off unless PostHog enables `kilo_encrypt` for the organization; always on in local development
 * so the page can be tested without PostHog.
 */
export async function isEnkryptGuardrailsFeatureEnabled(organizationId: string): Promise<boolean> {
  return (
    process.env.NODE_ENV === 'development' ||
    (await isReleaseToggleEnabled(KILO_ENCRYPT_FLAG, organizationId))
  );
}

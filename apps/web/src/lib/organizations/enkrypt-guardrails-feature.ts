import 'server-only';
import { ENKRYPT_GUARDRAILS_FLAG } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { isFeatureFlagEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';

export async function isEnkryptGuardrailsFeatureEnabled(organizationId: string): Promise<boolean> {
  return (
    process.env.NODE_ENV === 'development' ||
    (await isFeatureFlagEnabled(ENKRYPT_GUARDRAILS_FLAG, organizationId))
  );
}

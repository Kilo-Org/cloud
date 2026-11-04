import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  isOrganizationFeatureEnabled,
  readOrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/organization-features';

/**
 * Experimental BYOK providers, currently direct Amazon Bedrock and Google
 * Vertex AI, are a proof of concept. Keys for them can be added only by
 * organizations an admin enabled the `experimental_byok` organization feature for
 * in the gateway configuration.
 */
export async function isExperimentalByokEnabled(
  organizationId: string | null | undefined
): Promise<boolean> {
  if (!organizationId) return false;
  return isOrganizationFeatureEnabled(
    await readOrganizationFeatures(db),
    'experimental_byok',
    organizationId
  );
}

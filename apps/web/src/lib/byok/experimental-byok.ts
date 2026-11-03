import { KILO_ORGANIZATION_ID } from '@kilocode/web-shared/lib/organizations/constants';

/**
 * Experimental BYOK providers, currently direct Amazon Bedrock and Google
 * Vertex AI, are a proof of concept. Keys for them can be added outside
 * production, and in production only by the Kilo organization.
 */
export function isExperimentalByokEnabled(organizationId: string | null | undefined): boolean {
  return process.env.VERCEL_TARGET_ENV !== 'production' || organizationId === KILO_ORGANIZATION_ID;
}

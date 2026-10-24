import { KILO_ORGANIZATION_ID } from '@kilocode/web-shared/lib/organizations/constants';

/**
 * Direct Amazon Bedrock and Google Vertex AI BYOK is a proof of concept. Keys
 * can be added outside production, and in production only by the Kilo
 * organization.
 */
export function isDirectCloudByokAvailable(organizationId: string | null | undefined): boolean {
  return process.env.VERCEL_TARGET_ENV !== 'production' || organizationId === KILO_ORGANIZATION_ID;
}

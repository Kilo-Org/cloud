import {
  isOrganizationFeatureEnabled,
  readOrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { readDb } from '@kilocode/web-shared/lib/drizzle';

/** Whether an admin enabled the `request_logs` organization feature for the organization. */
export async function isRequestLogsEnabled(organizationId: string): Promise<boolean> {
  return isOrganizationFeatureEnabled(
    await readOrganizationFeatures(readDb),
    'request_logs',
    organizationId
  );
}

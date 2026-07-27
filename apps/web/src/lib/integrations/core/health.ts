import { platform_integrations } from '@kilocode/db/schema';
import { sql, type SQL } from 'drizzle-orm';
import { INTEGRATION_STATUS } from './constants';

type PlatformIntegrationHealthState = {
  integration_status: string | null;
  suspended_at: string | null;
  auth_invalid_at: string | null;
};

export function isPlatformIntegrationHealthy(
  integration: PlatformIntegrationHealthState | null | undefined
): boolean {
  return (
    integration?.integration_status === INTEGRATION_STATUS.ACTIVE &&
    integration.suspended_at === null &&
    integration.auth_invalid_at === null
  );
}

type PlatformIntegrationSuspensionState = Pick<
  PlatformIntegrationHealthState,
  'integration_status' | 'suspended_at'
>;

export function isPlatformIntegrationSuspended(
  integration: PlatformIntegrationSuspensionState | null | undefined
): boolean {
  return (
    integration?.integration_status === INTEGRATION_STATUS.SUSPENDED ||
    integration?.suspended_at != null
  );
}

export function platformIntegrationHealthSql(): SQL {
  return sql`
    ${platform_integrations.integration_status} = ${INTEGRATION_STATUS.ACTIVE}
    AND ${platform_integrations.suspended_at} IS NULL
    AND ${platform_integrations.auth_invalid_at} IS NULL
  `;
}

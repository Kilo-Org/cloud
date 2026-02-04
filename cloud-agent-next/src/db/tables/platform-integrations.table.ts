import { z } from 'zod';
import { getTable } from '../table.js';

// Table query interpolator for platform_integrations
export const platform_integrations = getTable({
  name: 'platform_integrations',
  columns: [
    'id',
    'owned_by_user_id',
    'owned_by_organization_id',
    'platform',
    'integration_type',
    'platform_installation_id',
    'platform_account_login',
    'integration_status',
    'github_app_type',
  ] as const,
});

// Zod schema for the lookup result (only the fields we need)
export const PlatformIntegrationLookupSchema = z.object({
  platform_installation_id: z.string(),
  platform_account_login: z.string(),
  github_app_type: z.enum(['standard', 'lite']).nullable().optional(),
});

export type PlatformIntegrationLookup = z.infer<typeof PlatformIntegrationLookupSchema>;

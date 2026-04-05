'use client';

import { useOrganizationTrialStatus } from '@/app/api/organizations/hooks';
import { isStatusReadOnly } from './trial-utils';

/**
 * Hook to determine if organization is in read-only mode
 * Returns true when trial expired (soft or hard lock)
 *
 * Both states are read-only (backend blocks all mutations):
 * - Soft lock: User can dismiss dialog and browse read-only
 * - Hard lock: User cannot dismiss, must upgrade or switch profile
 */
export function useOrganizationReadOnly(organizationId: string): boolean {
  const status = useOrganizationTrialStatus(organizationId);

  if (status === 'loading' || status === 'error') {
    return false;
  }

  return isStatusReadOnly(status);
}

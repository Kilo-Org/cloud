'use client';

import { useOrganizationTrialStatus } from '@/app/api/organizations/hooks';
import { isStatusReadOnly } from './trial-utils';

/**
 * Hook to determine if organization is in read-only mode.
 * Soft expiry is UI-only; hard-expired unentitled mutations are enforced server-side.
 */
export function useOrganizationReadOnly(organizationId: string): boolean {
  const status = useOrganizationTrialStatus(organizationId);

  if (status === 'loading' || status === 'error') {
    return false;
  }

  return isStatusReadOnly(status);
}

'use client';

import { useAdminPermissions } from '@/app/admin/useAdminPermissions';

export function useAdminCreditManagementPermission() {
  return useAdminPermissions();
}

import 'server-only';

import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

export type CreditManagementPermissionState = {
  is_admin: boolean;
  can_manage_credits: boolean;
};

export function hasCreditManagementAccess(
  permissions: CreditManagementPermissionState | undefined
): boolean {
  return permissions?.is_admin === true && permissions.can_manage_credits === true;
}

export async function userCanManageCredits(userId: string): Promise<boolean> {
  const [permissions] = await db
    .select({
      is_admin: kilocode_users.is_admin,
      can_manage_credits: kilocode_users.can_manage_credits,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  return hasCreditManagementAccess(permissions);
}

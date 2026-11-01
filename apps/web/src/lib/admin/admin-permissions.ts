import 'server-only';

import { eq } from 'drizzle-orm';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';

export function userIsSuperadmin(user: User): boolean {
  return user.is_admin && user.is_super_admin;
}

export function userCanViewSessions(user: User): boolean {
  return user.is_admin && user.can_view_sessions;
}

// The permission check reads the primary so a granted or revoked permission
// applies to a session that is already signed in.
export async function canCurrentUserViewSessions(kiloUserId: string): Promise<boolean> {
  const currentUser = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, kiloUserId),
  });

  if (!currentUser) {
    return false;
  }

  return currentUser.blocked_reason === null && userCanViewSessions(currentUser);
}

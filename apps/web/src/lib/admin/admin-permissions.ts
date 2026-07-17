import 'server-only';

import type { User } from '@kilocode/db/schema';

export function userIsSuperadmin(user: User): boolean {
  return user.is_admin && user.is_super_admin;
}

export function userCanViewSessions(user: User): boolean {
  return user.is_admin && user.can_view_sessions;
}

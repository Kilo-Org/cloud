import 'server-only';

import type { User } from '@kilocode/db/schema';

export function userCanManageCredits(user: User): boolean {
  return user.is_admin && user.can_manage_credits;
}

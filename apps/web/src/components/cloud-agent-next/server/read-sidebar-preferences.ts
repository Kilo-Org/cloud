import 'server-only';
import { cookies } from 'next/headers';
import { parseSidebarPreferences, SIDEBAR_PREFERENCES_COOKIE } from '../sidebar-preferences';
import type { SidebarPreferences } from '../sidebar-preferences';

/** The sidebar choices in this request's cookie, which is scoped to the route's account. */
export async function readSidebarPreferences(userId: string): Promise<SidebarPreferences | null> {
  const cookieStore = await cookies();
  return parseSidebarPreferences(cookieStore.get(SIDEBAR_PREFERENCES_COOKIE)?.value, userId);
}

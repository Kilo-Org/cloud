import * as z from 'zod';
import { parseCloudAgentCookie } from './cloud-agent-cookie';
import { DEFAULT_SIDEBAR_PLATFORM_FILTER } from './hooks/sidebar-queries';

/**
 * The sidebar choices the server renders with. They are kept in a cookie on the
 * Cloud Agent routes of one account (personal or one organization), so the first
 * HTML already shows the filtered rows and the collapsed folders.
 */
export type SidebarPreferences = {
  platformFilter: string[];
  projectFilter: string[];
  collapsedFolderIds: string[];
};

export const SIDEBAR_PREFERENCES_COOKIE = 'cloud-agent-sidebar';

const MAX_FILTER_ITEMS = 20;
const MAX_COLLAPSED_FOLDERS = 50;
// A browser ignores a cookie over 4 KB and keeps the old value.
const MAX_ENCODED_LENGTH = 3800;

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  platformFilter: DEFAULT_SIDEBAR_PLATFORM_FILTER,
  projectFilter: [],
  collapsedFolderIds: [],
};

const storedSchema = z.object({
  u: z.string(),
  p: z.array(z.string()).max(MAX_FILTER_ITEMS),
  r: z.array(z.string()).max(MAX_FILTER_ITEMS),
  c: z.array(z.string()).max(MAX_COLLAPSED_FOLDERS),
});

/** The stored choices, or null when the cookie is missing, malformed or another user's. */
export function parseSidebarPreferences(
  value: string | undefined,
  userId: string
): SidebarPreferences | null {
  const stored = parseCloudAgentCookie(value, userId, storedSchema);
  return stored
    ? { platformFilter: stored.p, projectFilter: stored.r, collapsedFolderIds: stored.c }
    : null;
}

/**
 * The encoded cookie value. When the choices do not fit, the oldest collapsed
 * folders and then the last project filters are left out.
 */
export function encodeSidebarPreferences(preferences: SidebarPreferences, userId: string): string {
  const platformFilter = preferences.platformFilter.slice(0, MAX_FILTER_ITEMS);
  let projectFilter = preferences.projectFilter.slice(0, MAX_FILTER_ITEMS);
  let collapsedFolderIds = preferences.collapsedFolderIds.slice(-MAX_COLLAPSED_FOLDERS);
  const encode = () =>
    encodeURIComponent(
      JSON.stringify({ u: userId, p: platformFilter, r: projectFilter, c: collapsedFolderIds })
    );
  let value = encode();
  while (value.length > MAX_ENCODED_LENGTH) {
    if (collapsedFolderIds.length > 0) collapsedFolderIds = collapsedFolderIds.slice(1);
    else if (projectFilter.length > 0) projectFilter = projectFilter.slice(0, -1);
    else break;
    value = encode();
  }
  return value;
}

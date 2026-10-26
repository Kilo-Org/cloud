'use client';

import { useEffect, useState } from 'react';
import type { SetStateAction } from 'react';
import * as z from 'zod';
import { writeCloudAgentCookie } from '../cloud-agent-cookie';
import {
  DEFAULT_SIDEBAR_PREFERENCES,
  SIDEBAR_PREFERENCES_COOKIE,
  encodeSidebarPreferences,
} from '../sidebar-preferences';
import type { SidebarPreferences } from '../sidebar-preferences';
import {
  getCollapsedWorkspaceFoldersStorageKey,
  parseCollapsedWorkspaceFolders,
} from '../workspace-folders';

type ListSetter = (action: SetStateAction<string[]>) => void;
type Scope = { userId: string; organizationId: string | null };

/**
 * The sidebar choices, starting from what the server rendered with. Each change
 * is written to the cookie the server reads on the next load.
 */
export function useSidebarPreferences(
  initial: SidebarPreferences | null,
  { userId, organizationId }: Scope
): SidebarPreferences & {
  setPlatformFilter: ListSetter;
  setProjectFilter: ListSetter;
  setCollapsedFolderIds: ListSetter;
} {
  const [preferences, setPreferences] = useState(initial ?? DEFAULT_SIDEBAR_PREFERENCES);
  const [hadCookie] = useState(initial !== null);
  const [setters] = useState(() => {
    const setList =
      (key: keyof SidebarPreferences): ListSetter =>
      action =>
        setPreferences(current => ({
          ...current,
          [key]: typeof action === 'function' ? action(current[key]) : action,
        }));
    return {
      setPlatformFilter: setList('platformFilter'),
      setProjectFilter: setList('projectFilter'),
      setCollapsedFolderIds: setList('collapsedFolderIds'),
    };
  });

  useEffect(() => {
    // A browser without the cookie keeps the choices it stored before it had one.
    if (!hadCookie) setPreferences(readStoredPreferences({ userId, organizationId }));
  }, [hadCookie, organizationId, userId]);

  useEffect(() => {
    writeCloudAgentCookie(
      SIDEBAR_PREFERENCES_COOKIE,
      encodeSidebarPreferences(preferences, userId),
      organizationId
    );
  }, [organizationId, preferences, userId]);

  return { ...preferences, ...setters };
}

const stringListSchema = z.array(z.string());

function readStoredList(key: string): string[] | null {
  try {
    const value = window.localStorage.getItem(key);
    if (value === null) return null;
    const parsed = stringListSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The choices this browser kept in `localStorage` before the cookie. */
function readStoredPreferences({ userId, organizationId }: Scope): SidebarPreferences {
  let collapsedFolderIds: string[] = [];
  try {
    const value = window.localStorage.getItem(
      getCollapsedWorkspaceFoldersStorageKey(userId, organizationId ?? undefined)
    );
    if (value !== null) collapsedFolderIds = parseCollapsedWorkspaceFolders(value);
  } catch {
    // Storage can be blocked.
  }
  return {
    platformFilter:
      readStoredList('cloud-sessions:platform-filter') ??
      DEFAULT_SIDEBAR_PREFERENCES.platformFilter,
    projectFilter:
      readStoredList(`cloud-sessions:project-filter:${organizationId ?? 'personal'}`) ?? [],
    collapsedFolderIds,
  };
}

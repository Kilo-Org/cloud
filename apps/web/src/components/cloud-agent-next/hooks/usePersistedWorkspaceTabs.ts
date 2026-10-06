'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { safeLocalStorage } from '@/lib/localStorage';
import { createWorkspaceTabsState, type WorkspaceTabsState } from '../workspace-tabs';
import {
  getWorkspaceTabsForScope,
  parseWorkspaceTabsByScope,
  setWorkspaceTabsForScope,
} from '../workspace-tabs-storage';

type ScopedWorkspaceTabs = {
  storageKey: string | null;
  scope: string | null;
  tabs: WorkspaceTabsState;
};

export function usePersistedWorkspaceTabs(
  storageKey: string | null,
  scope: string | null
): [WorkspaceTabsState, Dispatch<SetStateAction<WorkspaceTabsState>>] {
  const [entry, setEntry] = useState<ScopedWorkspaceTabs>(() => ({
    storageKey,
    scope,
    tabs: createWorkspaceTabsState(),
  }));
  const entryRef = useRef(entry);

  useEffect(() => {
    const loaded: ScopedWorkspaceTabs = {
      storageKey,
      scope,
      tabs: getWorkspaceTabsForScope(
        parseWorkspaceTabsByScope(
          storageKey === null ? null : safeLocalStorage.getItem(storageKey)
        ),
        scope
      ),
    };
    entryRef.current = loaded;
    setEntry(loaded);
  }, [storageKey, scope]);

  const setWorkspaceTabs = useCallback<Dispatch<SetStateAction<WorkspaceTabsState>>>(action => {
    const current = entryRef.current;
    const tabs = action instanceof Function ? action(current.tabs) : action;
    if (tabs === current.tabs) return;

    const next: ScopedWorkspaceTabs = { ...current, tabs };
    entryRef.current = next;
    setEntry(next);

    if (current.storageKey === null || current.scope === null) return;

    const tabsByScope = parseWorkspaceTabsByScope(safeLocalStorage.getItem(current.storageKey));
    safeLocalStorage.setItem(
      current.storageKey,
      JSON.stringify({ tabsByScope: setWorkspaceTabsForScope(tabsByScope, current.scope, tabs) })
    );
  }, []);

  const tabs =
    entry.storageKey === storageKey && entry.scope === scope
      ? entry.tabs
      : createWorkspaceTabsState();

  return [tabs, setWorkspaceTabs];
}

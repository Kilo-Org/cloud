'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
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
  storageUnavailable?: boolean;
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

  const getScopedState = useCallback(() => {
    const current = entryRef.current;
    const fallback: ScopedWorkspaceTabs =
      current.storageKey === storageKey && current.scope === scope
        ? current
        : {
            storageKey,
            scope,
            tabs: createWorkspaceTabsState(),
          };
    if (storageKey === null || scope === null || fallback.storageUnavailable)
      return { entry: fallback, tabsByScope: {} };
    try {
      const tabsByScope = parseWorkspaceTabsByScope(window.localStorage.getItem(storageKey));
      return {
        entry: { storageKey, scope, tabs: getWorkspaceTabsForScope(tabsByScope, scope) },
        tabsByScope,
      };
    } catch {
      return { entry: fallback, tabsByScope: {} };
    }
  }, [storageKey, scope]);

  useEffect(() => {
    const sync = () => {
      const { entry: loaded } = getScopedState();
      entryRef.current = loaded;
      setEntry(loaded);
    };
    sync();
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
      if (storageKey !== null && scope !== null && (event.key === storageKey || event.key === null))
        sync();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [getScopedState, storageKey, scope]);

  const setWorkspaceTabs = useCallback<Dispatch<SetStateAction<WorkspaceTabsState>>>(
    action => {
      const { entry: current, tabsByScope } = getScopedState();
      const tabs = action instanceof Function ? action(current.tabs) : action;
      if (current === entryRef.current && tabs === current.tabs) return;

      const next: ScopedWorkspaceTabs = { ...current, tabs };
      entryRef.current = next;
      setEntry(next);

      if (current.storageKey === null || current.scope === null || tabs === current.tabs) return;

      try {
        window.localStorage.setItem(
          current.storageKey,
          JSON.stringify({
            tabsByScope: setWorkspaceTabsForScope(tabsByScope, current.scope, tabs),
          })
        );
      } catch {
        next.storageUnavailable = true;
      }
    },
    [getScopedState]
  );

  const tabs =
    entry.storageKey === storageKey && entry.scope === scope
      ? entry.tabs
      : createWorkspaceTabsState();

  return [tabs, setWorkspaceTabs];
}

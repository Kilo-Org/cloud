'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  parseWorktreeChatTabs,
  reduceWorktreeChatTabs,
  type WorktreeChatTabsAction,
  type WorktreeChatTabsState,
} from '../worktree-chat-tabs';

type ScopedClosedWorktreeChatTabs = {
  storageKey: string | null;
  tabs: WorktreeChatTabsState;
  storageUnavailable?: boolean;
};

export function useClosedWorktreeChatTabs(storageKey: string | null) {
  const [state, setState] = useState<ScopedClosedWorktreeChatTabs | null>(null);
  const stateRef = useRef<ScopedClosedWorktreeChatTabs | null>(null);

  const getScopedState = useCallback(() => {
    const current = stateRef.current;
    const fallback: ScopedClosedWorktreeChatTabs =
      current?.storageKey === storageKey
        ? current
        : { storageKey, tabs: parseWorktreeChatTabs(null) };
    if (storageKey === null || fallback.storageUnavailable) return fallback;
    try {
      return { storageKey, tabs: parseWorktreeChatTabs(window.localStorage.getItem(storageKey)) };
    } catch {
      return fallback;
    }
  }, [storageKey]);

  // Before paint, so closed tabs never flash open while the stored state loads.
  useLayoutEffect(() => {
    const sync = () => {
      const loaded = getScopedState();
      stateRef.current = loaded;
      setState(loaded);
    };
    sync();
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
      if (storageKey !== null && (event.key === storageKey || event.key === null)) sync();
    };
    // A page restored from the back-forward cache missed storage events while it was cached.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) sync();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [getScopedState, storageKey]);

  const update = useCallback(
    (action: WorktreeChatTabsAction) => {
      const current = getScopedState();
      const tabs = reduceWorktreeChatTabs(current.tabs, action);
      const next: ScopedClosedWorktreeChatTabs =
        tabs === current.tabs ? current : { ...current, tabs };
      stateRef.current = next;
      setState(next);
      if (storageKey !== null && next !== current) {
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(tabs));
        } catch {
          next.storageUnavailable = true;
        }
      }
    },
    [getScopedState, storageKey]
  );

  const openChatTab = useCallback(
    (sessionId: string) => update({ type: 'open', sessionId }),
    [update]
  );
  const closeChatTab = useCallback(
    (sessionId: string) => update({ type: 'close', sessionId }),
    [update]
  );
  const replaceChatTab = useCallback(
    (
      worktreeId: string,
      oldSessionId: string,
      newSessionId: string,
      openSessionIds: readonly string[]
    ) => update({ type: 'replace', worktreeId, oldSessionId, newSessionId, openSessionIds }),
    [update]
  );

  const forgetWorktreeTabs = useCallback(
    (worktreeId: string, sessionIds: readonly string[]) =>
      update({ type: 'forgetWorktree', worktreeId, sessionIds }),
    [update]
  );

  const scopedState = state?.storageKey === storageKey ? state : null;
  return {
    closedSessionIds: scopedState?.tabs.closedSessionIds ?? [],
    sessionOrderByWorktree: scopedState?.tabs.sessionOrderByWorktree ?? {},
    openChatTab,
    closeChatTab,
    replaceChatTab,
    forgetWorktreeTabs,
  };
}

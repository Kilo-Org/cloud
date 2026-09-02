'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { safeLocalStorage } from '@/lib/localStorage';
import {
  parseWorktreeChatTabs,
  reduceWorktreeChatTabs,
  type WorktreeChatTabsAction,
  type WorktreeChatTabsState,
} from '../worktree-chat-tabs';

type ScopedClosedWorktreeChatTabs = {
  storageKey: string | null;
  tabs: WorktreeChatTabsState;
};

export function useClosedWorktreeChatTabs(storageKey: string | null) {
  const [state, setState] = useState<ScopedClosedWorktreeChatTabs | null>(null);
  const stateRef = useRef<ScopedClosedWorktreeChatTabs | null>(null);

  const getScopedState = useCallback(() => {
    const current = stateRef.current;
    if (current?.storageKey === storageKey) return current;

    const loaded = {
      storageKey,
      tabs: parseWorktreeChatTabs(
        storageKey === null ? null : safeLocalStorage.getItem(storageKey)
      ),
    };
    stateRef.current = loaded;
    return loaded;
  }, [storageKey]);

  useEffect(() => {
    setState(getScopedState());
  }, [getScopedState]);

  const update = useCallback(
    (action: WorktreeChatTabsAction) => {
      const current = getScopedState();
      const tabs = reduceWorktreeChatTabs(current.tabs, action);
      const next = tabs === current.tabs ? current : { storageKey, tabs };
      stateRef.current = next;
      setState(next);
      if (storageKey !== null && next !== current) {
        safeLocalStorage.setItem(storageKey, JSON.stringify(tabs));
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

  return {
    closedSessionIds: state?.storageKey === storageKey ? state.tabs.closedSessionIds : [],
    sessionOrderByWorktree:
      state?.storageKey === storageKey ? state.tabs.sessionOrderByWorktree : {},
    openChatTab,
    closeChatTab,
    replaceChatTab,
    forgetWorktreeTabs,
  };
}

import { useQuery } from '@tanstack/react-query';
import { type OlderMessagesError, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner-native';
import { ulid } from 'ulid';

import { i18n } from '@/i18n';
import { useAuth } from '@/lib/auth/auth-context';
import { getGatewayAuthTokenForRequest } from '@/lib/auth/credentials';
import { useOrganization } from '@/lib/organization-context';
import { trpcClient, useTRPC } from '@/lib/trpc';

import { type QuickChatGatewayMessage, streamQuickChatCompletion } from './quick-chat-gateway';
import {
  adaptQuickChatRow,
  type LocalTurn,
  mergeQuickChatRows,
  type QuickChatRow,
} from './quick-chat-messages';

/** One locally-accepted turn: the user row plus, once streaming starts, the assistant reply. */
type HookLocalTurn = {
  clientId: string;
  user: QuickChatRow;
  assistant: QuickChatRow | null;
};

/**
 * Data layer for the quick-chat tab. Owns the `listMessages` query, older-page
 * paging, the locally-accepted turns, and the gateway stream/append pipeline.
 * All local state is torn down and in-flight streams aborted when the auth
 * epoch or organization changes, so no stale account data survives a scope
 * switch.
 */
export function useQuickChat(model: string) {
  const { organizationId, isLoaded: orgLoaded } = useOrganization();
  const { authEpoch } = useAuth();
  const trpc = useTRPC();

  const [localTurns, setLocalTurns] = useState<HookLocalTurn[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [olderRows, setOlderRows] = useState<QuickChatRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<OlderMessagesError | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  const olderLoadingRef = useRef(false);
  // Bumped every time the newest page resets (or the scope changes), so an
  // older-page load that raced the reset can drop its now-stale result instead
  // of prepending rows contiguous with the old first page.
  const pageResetRef = useRef(0);

  const listQuery = useQuery({
    // Key the page by the auth epoch so a sign-in can never render the previous
    // account's cached page, and keep it disabled until the org scope hydrates
    // (the context starts as null while SecureStore loads, so an early fetch
    // would resolve the personal thread first and then swap when the stored org
    // arrives).
    queryKey: [...trpc.quickChat.listMessages.queryKey({ organizationId }), authEpoch],
    queryFn: async () => {
      const page = await trpcClient.quickChat.listMessages.query({ organizationId });
      return page;
    },
    enabled: orgLoaded,
  });

  const scopeKey = `${authEpoch}:${organizationId ?? 'personal'}`;
  const scopeKeyRef = useRef(scopeKey);

  // Remount all local state and drop any in-flight stream when the account or
  // organization scope changes.
  useEffect(() => {
    if (scopeKeyRef.current === scopeKey) {
      return;
    }
    scopeKeyRef.current = scopeKey;
    abortRef.current?.abort();
    abortRef.current = null;
    stopRef.current = null;
    setLocalTurns([]);
    setIsStreaming(false);
    setThreadId(null);
    setOlderRows([]);
    setNextCursor(null);
    nextCursorRef.current = null;
    setOlderError(null);
    setIsLoadingOlder(false);
    olderLoadingRef.current = false;
    pageResetRef.current += 1;
  }, [scopeKey]);

  // A plain unmount (flag-off redirect, tab teardown) leaves no scope-change:
  // the effect above returns early on the first mount, so it never registers a
  // cleanup. Abort the in-flight stream here so a completion never outlives the
  // screen.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
      stopRef.current = null;
    },
    []
  );

  // Resolve the thread id for the transcript list's reset key. The id is
  // cosmetic: listMessages/appendMessages resolve the thread server-side. The
  // create is gated on the same org-hydration flag as listMessages, so a mount
  // before SecureStore loads cannot write the personal thread by accident.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // The create is gated on the same org-hydration flag as listMessages, so
      // a mount before SecureStore loads cannot write the personal thread.
      if (!orgLoaded) {
        return;
      }
      try {
        const thread = await trpcClient.quickChat.getOrCreateThread.mutate({ organizationId });
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- `cancelled` flips in the cleanup when the scope changes mid-flight
        if (!cancelled) {
          setThreadId(thread.id);
        }
      } catch {
        // Keep `threadId` null; the screen falls back to the "pending" key.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeKey, organizationId, orgLoaded]);

  // A first-page refetch (send → append → refetch, or Retry) shifts the newest
  // window, so the older rows and the cursor must reset together: keeping old
  // `olderRows` while overwriting the cursor would leave a gap where the rows
  // that fell off the first page live, and a later older load would prepend
  // overlapping ids. Reset both so the next older load starts contiguous with
  // the new first page.
  useEffect(() => {
    const data = listQuery.data;
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- `data` is undefined while the query is disabled before the org scope hydrates
    if (data) {
      pageResetRef.current += 1;
      setOlderRows([]);
      nextCursorRef.current = data.nextCursor;
      setNextCursor(data.nextCursor);
      // A reset bumps `pageResetRef`, which makes an in-flight older load drop
      // its result and skip releasing the lock in its `finally`. Release the
      // lock here so pagination is not stuck behind the stale load.
      olderLoadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [listQuery.data]);

  const onLoadOlderMessages = () => {
    const cursor = nextCursorRef.current;
    if (cursor === null || olderLoadingRef.current) {
      return;
    }
    const resetGen = pageResetRef.current;
    olderLoadingRef.current = true;
    setIsLoadingOlder(true);
    setOlderError(null);
    void (async () => {
      try {
        const result = await trpcClient.quickChat.listMessages.query({ organizationId, cursor });
        // If a newest-page refetch or scope change reset the page since this
        // load started, the row window moved: prepending these rows would leave
        // a gap or duplicate ids. Drop the stale page.
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- a dropped page must not mix into the newer window
        if (pageResetRef.current !== resetGen) {
          return;
        }
        setOlderRows(prev => [...result.messages, ...prev]);
        nextCursorRef.current = result.nextCursor;
        setNextCursor(result.nextCursor);
      } catch {
        // A stale page's failure is not the current window's failure.
        if (pageResetRef.current !== resetGen) {
          return;
        }
        setOlderError({ kind: 'retryable' });
      } finally {
        // Only the load that still owns the reset generation clears the lock:
        // a stale load's finally must not clobber a newer load's
        // `olderLoadingRef`/loading indicator.
        if (pageResetRef.current === resetGen) {
          olderLoadingRef.current = false;
          setIsLoadingOlder(false);
        }
      }
    })();
  };

  const mergedRows = useMemo<QuickChatRow[]>(() => {
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- `listQuery.data` is undefined until the first page resolves
    const serverRows = [...olderRows, ...(listQuery.data?.messages ?? [])];
    const turns: LocalTurn[] = localTurns.map(turn => ({
      clientId: turn.clientId,
      rows: turn.assistant ? [turn.user, turn.assistant] : [turn.user],
    }));
    return mergeQuickChatRows(serverRows, turns);
  }, [olderRows, listQuery.data, localTurns]);

  const messages = useMemo<StoredMessage[]>(
    () => mergedRows.map(row => adaptQuickChatRow(row, threadId ?? 'pending')),
    [mergedRows, threadId]
  );

  function gatewayHistory(): QuickChatGatewayMessage[] {
    return mergedRows.map(row => ({ role: row.role, content: row.content }));
  }

  async function appendTurn(clientId: string, userContent: string, assistantContent: string) {
    // Defensive last line: a stream that completed just as the scope swapped
    // out (or before hydration ever finished) must never persist to the wrong
    // thread.
    if (!orgLoaded) {
      return;
    }
    const outgoing: { role: 'user' | 'assistant'; content: string; clientId?: string }[] = [
      { role: 'user', content: userContent, clientId },
    ];
    if (assistantContent.trim() !== '') {
      outgoing.push({ role: 'assistant', content: assistantContent });
    }
    try {
      await trpcClient.quickChat.appendMessages.mutate({ organizationId, messages: outgoing });
      void listQuery.refetch();
    } catch {
      // Keep the local rows; the merge keeps the turn visible on retry. The
      // failure copy is localized and generic: the gateway's raw error strings
      // are technical and never user-facing.
      toast.error(i18n.t('quickChat.sendError'));
    }
  }

  function startStream(
    clientId: string,
    userRow: QuickChatRow,
    history: QuickChatGatewayMessage[]
  ) {
    onStop();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);
    const assistantId = `local-${clientId}-assistant`;
    let assistantText = '';

    const finishTurn = () => {
      if (abortRef.current !== controller) {
        return;
      }
      abortRef.current = null;
      stopRef.current = null;
      setIsStreaming(false);
      void appendTurn(clientId, userRow.content, assistantText);
    };
    stopRef.current = () => {
      controller.abort();
      finishTurn();
    };

    void (async () => {
      try {
        const authToken = await getGatewayAuthTokenForRequest();
        if (abortRef.current !== controller) {
          return;
        }
        if (!authToken) {
          throw new Error('Missing auth token');
        }
        for await (const delta of streamQuickChatCompletion({
          model,
          messages: [...history, { role: 'user', content: userRow.content }],
          organizationId,
          authToken,
          signal: controller.signal,
        })) {
          if (abortRef.current !== controller) {
            return;
          }
          assistantText += delta;
          const content = assistantText;
          setLocalTurns(prev =>
            prev.map(turn =>
              turn.clientId === clientId
                ? {
                    ...turn,
                    assistant: {
                      id: assistantId,
                      role: 'assistant',
                      content,
                      createdAt: userRow.createdAt,
                    },
                  }
                : turn
            )
          );
        }
      } catch {
        if (!controller.signal.aborted) {
          toast.error(i18n.t('quickChat.sendError'));
        }
      } finally {
        finishTurn();
      }
    })();
  }

  function onSend(text: string): void {
    if (!orgLoaded) {
      // The org scope has not hydrated. Accepting would persist to the personal
      // thread before the stored org swaps in. Throw so the composer preserves
      // the draft (a plain return would clear it).
      throw new Error('Organization scope not loaded');
    }
    if (!model) {
      toast.error(i18n.t('quickChat.catalogRetry'));
      throw new Error('No model selected');
    }
    const clientId = ulid();
    const now = new Date().toISOString();
    const userRow: QuickChatRow = {
      id: `local-${clientId}`,
      role: 'user',
      content: text,
      createdAt: now,
      clientId,
    };
    const history = gatewayHistory();
    setLocalTurns(prev => [...prev, { clientId, user: userRow, assistant: null }]);
    startStream(clientId, userRow, history);
  }

  function onStop(): void {
    stopRef.current?.();
  }

  return {
    threadId,
    messages,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- the query is disabled while the org scope hydrates, but the screen must still treat that window as loading
    isLoading: listQuery.isLoading || !orgLoaded,
    isError: listQuery.isError,
    error: listQuery.error,
    refetch: listQuery.refetch,
    hasOlderMessages: nextCursor !== null,
    isLoadingOlderMessages: isLoadingOlder,
    olderMessagesError: olderError,
    olderMessagesOmittedItemCount: 0,
    onLoadOlderMessages,
    isStreaming,
    onSend,
    onStop,
  };
}

/* eslint-disable max-lines -- paging and admitted turn completion share the same owner boundary */
import { useQuery } from '@tanstack/react-query';
import { type OlderMessagesError, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner-native';
import { ulid } from 'ulid';

import { i18n } from '@/i18n';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { useOrganization } from '@/lib/organization-context';
import { trpcClient, useTRPC } from '@/lib/trpc';
import {
  type AcceptedWorkReceipt,
  assertAcceptedWorkReceipt,
  assertMobileActionAdmission,
  assertTransportOwner,
  captureMobileActionAdmission,
  getLocalAccessDenial,
  isTransportOwner,
  type MobileActionAdmission,
} from '@/lib/local-access-transport';
import { LocalAccessDeniedError } from '@/lib/local-access';

import { type QuickChatGatewayMessage, streamQuickChatCompletion } from './quick-chat-gateway';
import {
  adaptQuickChatRow,
  type LocalTurn,
  mergeQuickChatRows,
  type QuickChatRow,
} from './quick-chat-messages';

type HookLocalTurn = {
  clientId: string;
  user: QuickChatRow;
  assistant: QuickChatRow | null;
};

/** History and accepted turns stay bound to their captured account and context. */
export function useQuickChat(model: string) {
  const { organizationId, isReady: orgReady, owner } = useOrganization();
  const ready = orgReady && owner.userId !== null && isTransportOwner(owner);
  const trpc = useTRPC();
  const scopeKey = JSON.stringify([
    owner.userId,
    owner.authEpoch,
    owner.generation,
    organizationId,
  ]);
  const scopeKeyRef = useRef(scopeKey);
  const visibleScopeRef = useRef(scopeKey);
  visibleScopeRef.current = scopeKey;
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
  const pageResetRef = useRef(0);

  const listQuery = useQuery({
    queryKey: [
      ...trpc.quickChat.listMessages.queryKey({ organizationId }),
      owner.userId,
      owner.authEpoch,
      owner.generation,
    ],
    queryFn: async ({ signal }) => {
      assertTransportOwner(owner);
      const page = await trpcClient.quickChat.listMessages.query(
        { organizationId },
        {
          signal,
          context: { localAccessOwner: owner },
        }
      );
      assertTransportOwner(owner);
      return page;
    },
    enabled: ready,
  });

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

  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
      stopRef.current = null;
    },
    []
  );

  // Reset the older window with every accepted first page. Keep the existing page-race fence.
  useEffect(() => {
    const data = listQuery.data;
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- the disabled query has no first page
    if (data) {
      pageResetRef.current += 1;
      setOlderRows([]);
      nextCursorRef.current = data.nextCursor;
      setNextCursor(data.nextCursor);
      olderLoadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [listQuery.data]);

  const isVisibleOwner = () => isTransportOwner(owner) && visibleScopeRef.current === scopeKey;
  const onLoadOlderMessages = () => {
    const cursor = nextCursorRef.current;
    if (!ready || cursor === null || olderLoadingRef.current) {
      return;
    }
    const resetGen = pageResetRef.current;
    olderLoadingRef.current = true;
    setIsLoadingOlder(true);
    setOlderError(null);
    void (async () => {
      try {
        const result = await trpcClient.quickChat.listMessages.query(
          { organizationId, cursor },
          {
            context: { localAccessOwner: owner },
          }
        );
        if (!isVisibleOwner() || pageResetRef.current !== resetGen) {
          return;
        }
        setOlderRows(prev => [...result.messages, ...prev]);
        nextCursorRef.current = result.nextCursor;
        setNextCursor(result.nextCursor);
      } catch {
        if (!isVisibleOwner() || pageResetRef.current !== resetGen) {
          return;
        }
        setOlderError({ kind: 'retryable' });
      } finally {
        if (isVisibleOwner() && pageResetRef.current === resetGen) {
          olderLoadingRef.current = false;
          setIsLoadingOlder(false);
        }
      }
    })();
  };

  const mergedRows = useMemo<QuickChatRow[]>(() => {
    if (scopeKeyRef.current !== scopeKey || !ready) {
      return [];
    }
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- history is absent until its first response
    const serverRows = [...olderRows, ...(listQuery.data?.messages ?? [])];
    const turns: LocalTurn[] = localTurns.map(turn => ({
      clientId: turn.clientId,
      rows: turn.assistant ? [turn.user, turn.assistant] : [turn.user],
    }));
    return mergeQuickChatRows(serverRows, turns);
  }, [olderRows, listQuery.data, localTurns, scopeKey, ready]);
  const messages = useMemo<StoredMessage[]>(
    () => mergedRows.map(row => adaptQuickChatRow(row, threadId ?? 'pending')),
    [mergedRows, threadId]
  );

  async function appendTurn(
    receipt: AcceptedWorkReceipt,
    turn: HookLocalTurn,
    assistantContent: string
  ) {
    if (!isTransportOwner(owner)) {
      // Account replacement safely cancels publication; never request a replacement token.
      return;
    }
    const { clientId } = turn;
    const outgoing: { role: 'user' | 'assistant'; content: string; clientId?: string }[] = [
      { role: 'user', content: turn.user.content, clientId },
    ];
    if (assistantContent.trim() !== '') {
      outgoing.push({ role: 'assistant', content: assistantContent });
    }
    try {
      assertAcceptedWorkReceipt(receipt, {
        kind: 'quick-chat-turn',
        organizationId,
        workId: clientId,
      });
      await trpcClient.quickChat.appendMessages.mutate(
        { organizationId, messages: outgoing },
        {
          context: { localAccessOwner: owner, localAccessReceipt: receipt },
        }
      );
      if (isVisibleOwner()) {
        void listQuery.refetch();
      }
    } catch {
      if (isVisibleOwner()) {
        toast.error(i18n.t('quickChat.sendError'));
      }
    }
  }

  // eslint-disable-next-line typescript-eslint/promise-function-async -- return the dispatch promise, not the streamed answer
  function startStream(
    acceptedTurn: HookLocalTurn,
    history: QuickChatGatewayMessage[],
    admission: MobileActionAdmission
  ): Promise<AcceptedWorkReceipt> {
    const { clientId, user: userRow } = acceptedTurn;
    onStop();
    const controller = new AbortController();
    // Use the Promise constructor on Hermes versions without withResolvers.
    return new Promise<AcceptedWorkReceipt>((resolve, reject) => {
      abortRef.current = controller;
      setIsStreaming(true);
      const assistantId = `local-${clientId}-assistant`;
      let assistantText = '';
      let receipt: AcceptedWorkReceipt | undefined = undefined;
      let finished = false;
      const isCurrentStream = () => abortRef.current === controller && isVisibleOwner();
      const finishTurn = () => {
        if (finished) {
          return;
        }
        finished = true;
        if (isCurrentStream()) {
          abortRef.current = null;
          stopRef.current = null;
          setIsStreaming(false);
        }
        if (receipt) {
          void appendTurn(receipt, acceptedTurn, assistantText);
        } else {
          reject(new LocalAccessDeniedError('stale'));
          if (isVisibleOwner()) {
            setLocalTurns(prev => prev.filter(turn => turn.clientId !== clientId));
          }
        }
      };
      stopRef.current = () => {
        controller.abort();
        finishTurn();
      };

      void (async () => {
        try {
          // Thread creation is a new foreground effect, not a passive mount side effect.
          const thread = await trpcClient.quickChat.getOrCreateThread.mutate(
            { organizationId },
            {
              signal: controller.signal,
              context: { localAccessOwner: owner, localAccessAdmission: admission },
            }
          );
          assertMobileActionAdmission(admission);
          if (!isCurrentStream()) {
            throw new LocalAccessDeniedError('stale');
          }
          setThreadId(thread.id);
          const authToken = await getAuthTokenForRequest();
          assertMobileActionAdmission(admission);
          if (!authToken) {
            throw new Error('Missing auth token');
          }
          for await (const delta of streamQuickChatCompletion({
            model,
            messages: [...history, { role: 'user', content: userRow.content }],
            organizationId,
            authToken,
            admission,
            turnId: clientId,
            onDispatch: accepted => {
              assertAcceptedWorkReceipt(accepted, {
                kind: 'quick-chat-turn',
                organizationId,
                workId: clientId,
              });
              receipt = accepted;
              resolve(accepted);
            },
            signal: controller.signal,
          })) {
            if (!isCurrentStream()) {
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
        } catch (error) {
          const denial = getLocalAccessDenial(error);
          // Once dispatch resolves, a later stream failure cannot change that settlement.
          const failure =
            denial ??
            (error instanceof Error
              ? error
              : new Error('Quick Chat dispatch failed', { cause: error }));
          reject(failure);
          if (isVisibleOwner() && !controller.signal.aborted && !denial) {
            toast.error(i18n.t('quickChat.sendError'));
          }
        } finally {
          finishTurn();
        }
      })();
    });
  }

  // eslint-disable-next-line typescript-eslint/promise-function-async -- preserve synchronous entry denial and expose final dispatch settlement
  function onSend(text: string): Promise<AcceptedWorkReceipt> {
    if (!ready) {
      throw new LocalAccessDeniedError('context');
    }
    if (!model) {
      toast.error(i18n.t('quickChat.catalogRetry'));
      throw new Error('No model selected');
    }
    const admission = captureMobileActionAdmission(owner, organizationId);
    const clientId = ulid();
    const userRow: QuickChatRow = {
      id: `local-${clientId}`,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      clientId,
    };
    const history = mergedRows.map(row => ({ role: row.role, content: row.content }));
    const turn = { clientId, user: userRow, assistant: null };
    setLocalTurns(prev => [...prev, turn]);
    return startStream(turn, history, admission);
  }

  function onStop(): void {
    stopRef.current?.();
  }

  return {
    threadId: scopeKeyRef.current === scopeKey ? threadId : null,
    messages,
    isLoading: listQuery.isLoading || !ready,
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

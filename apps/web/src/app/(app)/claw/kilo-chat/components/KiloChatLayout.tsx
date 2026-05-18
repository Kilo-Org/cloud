'use client';

import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { formatKiloChatError } from '@kilocode/kilo-chat';
import { usePresenceSubscription } from '@kilocode/kilo-chat-hooks';
import { ConversationList } from './ConversationList';
import { KiloChatContext, type KiloChatContextValue } from './kiloChatContext';
import {
  CHAT_ROOT_AUTO_OPEN_SUPPRESSION_PARAM,
  getChatRootLandingDecision,
  getSuppressedChatRootPath,
  shouldIgnoreRootEmptyConversationCreateResult,
  shouldStartRootEmptyConversationCreate,
} from './chat-root-selection-state';
import { kiloclawInstanceContext } from '@kilocode/event-service';
import { useEventServiceClient } from '@/contexts/EventServiceContext';
import { cn } from '@/lib/utils';
import {
  useConversations,
  useCreateConversation,
  useRenameConversation,
  useLeaveConversation,
  conversationsKey,
  createConversationMutationKey,
  registerConversationListCacheHandlers,
} from '../hooks/useConversations';

type RootLandingState = {
  hasResolvedRootLanding: boolean;
  hasAttemptedEmptyConversationCreate: boolean;
};

function hasCreateConversationSandboxId(
  variables: unknown,
  sandboxId: string | null
): variables is { sandboxId: string } {
  return (
    sandboxId !== null &&
    typeof variables === 'object' &&
    variables !== null &&
    'sandboxId' in variables &&
    variables.sandboxId === sandboxId
  );
}

// ── Layout component ────────────────────────────────────────────────
type KiloChatLayoutProps = {
  currentUserId: string | null;
  sandboxId: string | null;
  basePath: string;
  noInstanceRedirect: string;
  isInstanceLoading: boolean;
  isInstanceError: boolean;
  instanceErrorMessage: string | null;
  onRetryInstanceStatus: () => void;
  instanceStatus: string | null;
  assistantName: string | null;
  assistantEmoji: string | null;
  className?: string;
  children: React.ReactNode;
};

export function KiloChatLayout({
  currentUserId,
  sandboxId,
  basePath,
  noInstanceRedirect,
  isInstanceLoading,
  isInstanceError,
  instanceErrorMessage,
  onRetryInstanceStatus,
  instanceStatus,
  assistantName,
  assistantEmoji,
  className,
  children,
}: KiloChatLayoutProps) {
  const router = useRouter();

  const { eventService, kiloChatClient } = useEventServiceClient();
  usePresenceSubscription(
    sandboxId ? kiloclawInstanceContext(sandboxId) : null,
    Boolean(sandboxId)
  );

  const queryClient = useQueryClient();
  const params = useParams<{ conversationId?: string }>();
  const searchParams = useSearchParams();
  const isRootAutoOpenSuppressed = searchParams.get(CHAT_ROOT_AUTO_OPEN_SUPPRESSION_PARAM) === '1';
  const [leavingConversationId, setLeavingConversationId] = useState<string | null>(null);
  const conversationsQueryKey = useMemo(() => conversationsKey(sandboxId), [sandboxId]);
  const {
    data,
    isError: isConversationHistoryQueryError,
    isFetching: isFetchingConversationHistory,
    isRefetchError: hasConversationHistoryRefetchError,
    isFetchNextPageError: hasConversationPaginationError,
    isLoading,
    fetchNextPage,
    refetch: refetchConversationHistory,
    hasNextPage,
    isFetchingNextPage,
  } = useConversations(kiloChatClient, sandboxId, { refetchOnMount: 'always' });
  const hasConversationHistoryError =
    (isConversationHistoryQueryError && data === undefined) ||
    (hasConversationHistoryRefetchError && !hasConversationPaginationError);

  // Update loaded conversation-list cache rows in-place when instance events arrive.
  // Unknown conversations still invalidate so they can be fetched into the list.
  useEffect(() => {
    return registerConversationListCacheHandlers({
      activeConversationId: params?.conversationId ?? null,
      currentUserId,
      eventService,
      kiloChatClient,
      queryClient,
      queryKey: conversationsQueryKey,
      sandboxId,
    });
  }, [
    currentUserId,
    eventService,
    kiloChatClient,
    params?.conversationId,
    queryClient,
    conversationsQueryKey,
    sandboxId,
  ]);

  const createConversation = useCreateConversation(kiloChatClient);
  const renameConversation = useRenameConversation(kiloChatClient);
  const leaveConversation = useLeaveConversation(kiloChatClient);
  const [newConversationError, setNewConversationError] = useState<string | null>(null);
  const pendingCreateConversationCount = useIsMutating({
    mutationKey: createConversationMutationKey,
    predicate: mutation => hasCreateConversationSandboxId(mutation.state.variables, sandboxId),
  });
  const isCreatingConversation = pendingCreateConversationCount > 0;
  const latestSandboxId = useRef(sandboxId);
  latestSandboxId.current = sandboxId;
  const latestActiveConversationId = useRef(params?.conversationId ?? null);
  latestActiveConversationId.current = params?.conversationId ?? null;
  const latestIsRootAutoOpenSuppressed = useRef(isRootAutoOpenSuppressed);
  latestIsRootAutoOpenSuppressed.current = isRootAutoOpenSuppressed;
  const rootLandingState = useRef<RootLandingState>({
    hasResolvedRootLanding: false,
    hasAttemptedEmptyConversationCreate: false,
  });

  const handleRename = useCallback(
    (conversationId: string, title: string) => {
      renameConversation.mutate(
        { sandboxId, conversationId, title },
        { onError: err => toast.error(formatKiloChatError(err, 'Failed to rename conversation')) }
      );
    },
    [sandboxId, renameConversation.mutate]
  );

  const handleLeave = useCallback(
    (conversationId: string) => {
      const isActiveConversation = params?.conversationId === conversationId;
      setLeavingConversationId(conversationId);
      leaveConversation.mutate(
        { sandboxId, conversationId },
        {
          onSettled: () => setLeavingConversationId(null),
          onSuccess: () => {
            if (isActiveConversation) {
              router.push(getSuppressedChatRootPath(basePath));
            }
          },
          onError: err => {
            toast.error(formatKiloChatError(err, 'Failed to leave conversation'));
          },
        }
      );
    },
    [sandboxId, leaveConversation.mutate, params?.conversationId, router, basePath]
  );

  const handleNewConversation = useCallback(() => {
    if (!sandboxId || isCreatingConversation) return;
    if (!params?.conversationId) {
      rootLandingState.current.hasResolvedRootLanding = true;
      rootLandingState.current.hasAttemptedEmptyConversationCreate = true;
    }
    setNewConversationError(null);
    createConversation.mutate(
      { sandboxId },
      {
        onSuccess: res => {
          if (latestSandboxId.current !== sandboxId) {
            return;
          }
          rootLandingState.current.hasAttemptedEmptyConversationCreate = false;
          setNewConversationError(null);
          router.push(`${basePath}/${res.conversationId}`);
        },
        onError: err => {
          if (latestSandboxId.current !== sandboxId) {
            return;
          }
          const message = formatKiloChatError(
            err,
            "Couldn't create conversation. Check your connection and try again."
          );
          setNewConversationError(message);
          toast.error(message);
        },
      }
    );
  }, [
    sandboxId,
    basePath,
    isCreatingConversation,
    createConversation.mutate,
    params?.conversationId,
    router,
  ]);

  const contextValue = useMemo<KiloChatContextValue>(
    () => ({
      currentUserId,
      instanceStatus,
      leavingConversationId,
      assistantName,
      assistantEmoji,
      sandboxId,
      basePath,
      noInstanceRedirect,
      isInstanceLoading,
      isInstanceError,
      instanceErrorMessage,
      onRetryInstanceStatus,
      eventService,
      kiloChatClient,
    }),
    [
      currentUserId,
      instanceStatus,
      leavingConversationId,
      assistantName,
      assistantEmoji,
      sandboxId,
      basePath,
      noInstanceRedirect,
      isInstanceLoading,
      isInstanceError,
      instanceErrorMessage,
      onRetryInstanceStatus,
      eventService,
      kiloChatClient,
    ]
  );

  useEffect(() => {
    rootLandingState.current = {
      hasResolvedRootLanding: false,
      hasAttemptedEmptyConversationCreate: false,
    };
    setNewConversationError(null);
  }, [sandboxId]);

  useEffect(() => {
    if (params?.conversationId) {
      rootLandingState.current.hasResolvedRootLanding = false;
    }
  }, [params?.conversationId]);

  useEffect(() => {
    const latestConversationId = data?.conversations[0]?.conversationId ?? null;
    const landingDecision = getChatRootLandingDecision({
      activeConversationId: params?.conversationId ?? null,
      hasConversationHistoryData: data !== undefined,
      hasConversationHistoryError,
      hasResolvedRootLanding: rootLandingState.current.hasResolvedRootLanding,
      isAutoOpenSuppressed: isRootAutoOpenSuppressed,
      isFetchingConversationHistory,
      isLoading,
      latestConversationId,
      sandboxId,
    });

    if (landingDecision === 'wait' || landingDecision === 'stay') {
      return;
    }

    if (
      landingDecision === 'create-empty-conversation' &&
      !shouldStartRootEmptyConversationCreate({
        hasAttemptedEmptyConversationCreate:
          rootLandingState.current.hasAttemptedEmptyConversationCreate,
        isCreatePending: isCreatingConversation,
        landingDecision,
        sandboxId,
      })
    ) {
      return;
    }

    if (landingDecision === 'open-latest') {
      rootLandingState.current.hasResolvedRootLanding = true;
      if (latestConversationId !== null) {
        router.replace(`${basePath}/${latestConversationId}`);
      }
      return;
    }

    if (sandboxId === null) {
      return;
    }
    rootLandingState.current.hasAttemptedEmptyConversationCreate = true;
    setNewConversationError(null);
    createConversation.mutate(
      { sandboxId },
      {
        onSuccess: res => {
          if (
            shouldIgnoreRootEmptyConversationCreateResult({
              activeConversationId: latestActiveConversationId.current,
              currentSandboxId: latestSandboxId.current,
              hasResolvedRootLanding: rootLandingState.current.hasResolvedRootLanding,
              isAutoOpenSuppressed: latestIsRootAutoOpenSuppressed.current,
              mutationSandboxId: sandboxId,
            })
          ) {
            return;
          }
          rootLandingState.current.hasAttemptedEmptyConversationCreate = false;
          setNewConversationError(null);
          router.replace(`${basePath}/${res.conversationId}`);
        },
        onError: err => {
          if (
            shouldIgnoreRootEmptyConversationCreateResult({
              activeConversationId: latestActiveConversationId.current,
              currentSandboxId: latestSandboxId.current,
              hasResolvedRootLanding: rootLandingState.current.hasResolvedRootLanding,
              isAutoOpenSuppressed: latestIsRootAutoOpenSuppressed.current,
              mutationSandboxId: sandboxId,
            })
          ) {
            return;
          }
          const message = formatKiloChatError(
            err,
            "Couldn't create conversation. Check your connection and try again."
          );
          setNewConversationError(message);
          toast.error(message);
        },
      }
    );
  }, [
    basePath,
    createConversation.mutate,
    data,
    hasConversationHistoryError,
    isCreatingConversation,
    isFetchingConversationHistory,
    isLoading,
    isRootAutoOpenSuppressed,
    params?.conversationId,
    router,
    sandboxId,
  ]);

  return (
    <KiloChatContext.Provider value={contextValue}>
      <div className={cn('flex min-h-0 overflow-hidden', className ?? 'h-[calc(100dvh-3.5rem)]')}>
        {/* Conversation sidebar */}
        <div className="border-border flex w-64 shrink-0 flex-col overflow-hidden border-r">
          <ConversationList
            conversations={data?.conversations ?? []}
            hasConversationHistoryError={hasConversationHistoryError}
            hasConversationPaginationError={hasConversationPaginationError}
            isLoading={isLoading}
            hasNextPage={!!hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isCreatingConversation={isCreatingConversation}
            newConversationError={newConversationError}
            onLoadMore={() => void fetchNextPage()}
            onRetryConversationHistory={() => void refetchConversationHistory()}
            onNewConversation={handleNewConversation}
            onRename={handleRename}
            onLeave={handleLeave}
          />
        </div>

        {/* Main content */}
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
      </div>
    </KiloChatContext.Provider>
  );
}

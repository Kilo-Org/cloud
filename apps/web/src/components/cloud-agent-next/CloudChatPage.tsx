'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { ArrowDown, GitBranch } from 'lucide-react';

import type { KiloSessionId } from '@/lib/cloud-agent-sdk';
import { useManager } from './CloudAgentProvider';
import { MobileSidebarToggle } from './MobileSidebarToggle';
import { ChatHeader } from './ChatHeader';
import { ChatInput } from './ChatInput';
import { MessageErrorBoundary } from './MessageErrorBoundary';
import { MessageBubble } from './MessageBubble';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { WorkingIndicator } from './WorkingIndicator';
import { QuestionToolCard } from './QuestionToolCard';
import { QuestionContextProvider } from './QuestionContext';
import { PermissionCard, PermissionContextProvider } from './PermissionCard';
import { SuggestionContextProvider } from './SuggestionCard';
import { SessionContinuationPanel } from './SessionContinuationPanel';
import { isMessageStreaming } from './types';
import { useOrganizationModels } from './hooks/useOrganizationModels';
import { useSlashCommandSets } from '@/hooks/useSlashCommandSets';
import { useCelebrationSound } from '@/hooks/useCelebrationSound';
import {
  CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
  CLOUD_AGENT_IMAGE_MAX_COUNT,
  CLOUD_AGENT_IMAGE_MAX_DIMENSION_PX,
  CLOUD_AGENT_IMAGE_MAX_ORIGINAL_SIZE_BYTES,
  CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES,
} from '@/lib/cloud-agent/constants';

import { SetPageTitle } from '@/components/SetPageTitle';
import { formatShortModelDisplayName } from '@/lib/format-model-name';
import type { AgentMode } from './types';
import type { StoredMessage } from '@/lib/cloud-agent-sdk';
import type { Images } from '@/lib/images-schema';

// ---------------------------------------------------------------------------
// Static messages — memoized, never re-renders during streaming
// ---------------------------------------------------------------------------
const StaticMessages = memo(
  ({
    messages,
    getChildMessages,
  }: {
    messages: StoredMessage[];
    getChildMessages?: (sessionId: string) => StoredMessage[];
  }) => (
    <>
      {messages.map(msg => (
        <MessageErrorBoundary key={msg.info.id}>
          <MessageBubble message={msg} getChildMessages={getChildMessages} />
        </MessageErrorBoundary>
      ))}
    </>
  )
);
StaticMessages.displayName = 'StaticMessages';

// ---------------------------------------------------------------------------
// Dynamic messages — re-renders as streaming progresses
// ---------------------------------------------------------------------------
function DynamicMessages({
  messages,
  getChildMessages,
}: {
  messages: StoredMessage[];
  getChildMessages?: (sessionId: string) => StoredMessage[];
}) {
  return (
    <>
      {messages.map(msg => {
        const streaming = isMessageStreaming(msg);
        return (
          <MessageErrorBoundary key={msg.info.id}>
            <MessageBubble
              message={msg}
              isStreaming={streaming}
              getChildMessages={getChildMessages}
            />
          </MessageErrorBoundary>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// CloudChatPage
// ---------------------------------------------------------------------------
const emptyQuestionRequestIds = new Map<string, string>();

type CloudChatPageProps = { organizationId?: string };

export default function CloudChatPage({ organizationId }: CloudChatPageProps) {
  const manager = useManager();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { mutateAsync: personalUploadUrl } = useMutation(
    trpc.cloudAgentNext.getImageUploadUrl.mutationOptions()
  );
  const { mutateAsync: orgUploadUrl } = useMutation(
    trpc.organizations.cloudAgentNext.getImageUploadUrl.mutationOptions()
  );
  // URL-driven session switching
  const sessionIdFromParams = searchParams?.get('sessionId');
  useEffect(() => {
    if (sessionIdFromParams) {
      void manager.switchSession(sessionIdFromParams as KiloSessionId);
    }
  }, [sessionIdFromParams, manager]);

  // -- Manager atoms --------------------------------------------------------
  const isStreaming = useAtomValue(manager.atoms.isStreaming);
  const isLoading = useAtomValue(manager.atoms.isLoading);
  const isReadOnly = useAtomValue(manager.atoms.isReadOnly);
  const canSend = useAtomValue(manager.atoms.canSend);
  const statusIndicator = useAtomValue(manager.atoms.statusIndicator);
  const sessionConfig = useAtomValue(manager.atoms.sessionConfig);
  const sessionId = useAtomValue(manager.atoms.sessionId);
  const activity = useAtomValue(manager.atoms.activity);
  const cloudStatus = useAtomValue(manager.atoms.cloudStatus);
  const activeQuestion = useAtomValue(manager.atoms.activeQuestion);
  const activePermission = useAtomValue(manager.atoms.activePermission);
  const activeSuggestion = useAtomValue(manager.atoms.activeSuggestion);
  const failedPrompt = useAtomValue(manager.atoms.failedPrompt);
  const staticMessages = useAtomValue(manager.atoms.staticMessages);
  const dynamicMessages = useAtomValue(manager.atoms.dynamicMessages);
  const totalCost = useAtomValue(manager.atoms.totalCost);
  const getChildMessages = useAtomValue(manager.atoms.childMessages);
  const fetchedSessionData = useAtomValue(manager.atoms.fetchedSessionData);

  const setSessionConfig = useSetAtom(manager.atoms.sessionConfig);

  const [imageMessageUuid, setImageMessageUuid] = useState(() => crypto.randomUUID());

  // -- Organization models --------------------------------------------------
  const { modelOptions, isLoadingModels } = useOrganizationModels(organizationId);
  const { availableCommands } = useSlashCommandSets();

  // -- Sound effects --------------------------------------------------------
  const { play: playCelebrationSound, soundEnabled, setSoundEnabled } = useCelebrationSound();

  const prevActivityRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevActivityRef.current === 'busy' && activity.type === 'idle') {
      playCelebrationSound();
      void queryClient.invalidateQueries(trpc.unifiedSessions.list.pathFilter());
    }
    prevActivityRef.current = activity.type;
  }, [activity.type, playCelebrationSound, queryClient, trpc]);

  // -- Scroll ---------------------------------------------------------------
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const chatUI = useAtomValue(manager.atoms.chatUI);
  const setChatUI = useSetAtom(manager.atoms.chatUI);

  // Flag to distinguish programmatic scrolls from user scrolls.
  // Without this, auto-scroll's scrollTo fires handleScroll which re-enables
  // shouldAutoScroll, making it impossible for the user to scroll away during streaming.
  const isAutoScrollingRef = useRef(false);
  const autoScrollRunRef = useRef(0);
  const lastScrollTopRef = useRef(0);

  const autoScrollFrameRef = useRef(0);
  const delayedAutoScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToBottomNow = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const scrollRun = autoScrollRunRef.current + 1;
    autoScrollRunRef.current = scrollRun;
    isAutoScrollingRef.current = true;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
    setShowScrollButton(false);

    requestAnimationFrame(() => {
      if (autoScrollRunRef.current === scrollRun) {
        isAutoScrollingRef.current = false;
      }
    });
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    cancelAnimationFrame(autoScrollFrameRef.current);
    if (delayedAutoScrollRef.current !== null) {
      clearTimeout(delayedAutoScrollRef.current);
      delayedAutoScrollRef.current = null;
    }

    autoScrollFrameRef.current = requestAnimationFrame(() => {
      scrollToBottomNow();
      requestAnimationFrame(scrollToBottomNow);
      delayedAutoScrollRef.current = setTimeout(() => {
        delayedAutoScrollRef.current = null;
        scrollToBottomNow();
      }, 100);
    });
  }, [scrollToBottomNow]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(autoScrollFrameRef.current);
      if (delayedAutoScrollRef.current !== null) {
        clearTimeout(delayedAutoScrollRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!chatUI.shouldAutoScroll) return;
    scheduleScrollToBottom();
  }, [staticMessages, dynamicMessages, chatUI.shouldAutoScroll, scheduleScrollToBottom]);

  useEffect(() => {
    if (!chatUI.shouldAutoScroll) return;
    if (typeof ResizeObserver === 'undefined') return;

    const content = messagesContentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      scheduleScrollToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [chatUI.shouldAutoScroll, scheduleScrollToBottom]);

  useEffect(() => {
    if (!sessionIdFromParams) return;

    setChatUI({ shouldAutoScroll: true });
    lastScrollTopRef.current = 0;
    setShowScrollButton(false);
    scheduleScrollToBottom();
  }, [sessionIdFromParams, setChatUI, scheduleScrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollButton(distanceFromBottom > 20);

    if (isAutoScrollingRef.current) {
      lastScrollTopRef.current = el.scrollTop;
      return;
    }

    const scrolledUp = el.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;

    if (scrolledUp) {
      setChatUI({ shouldAutoScroll: false });
    } else if (distanceFromBottom < 100) {
      setChatUI({ shouldAutoScroll: true });
    }
  }, [setChatUI]);

  const scrollToBottom = useCallback(() => {
    setChatUI({ shouldAutoScroll: true });
    scheduleScrollToBottom();
  }, [scheduleScrollToBottom, setChatUI]);

  // -- Handlers -------------------------------------------------------------
  const handleSendMessage = useCallback(
    async (prompt: string, images?: Images) => {
      setChatUI({ shouldAutoScroll: true });
      const acceptedPromise = manager.send({
        prompt,
        mode: sessionConfig?.mode ?? 'code',
        model: sessionConfig?.model ?? '',
        variant: sessionConfig?.variant ?? undefined,
        images,
      });
      scheduleScrollToBottom();

      const accepted = await acceptedPromise;
      if (accepted) {
        setImageMessageUuid(crypto.randomUUID());
        scheduleScrollToBottom();
      }
      return accepted;
    },
    [manager, scheduleScrollToBottom, sessionConfig, setChatUI]
  );

  const handleStopExecution = useCallback(() => {
    void manager.interrupt();
  }, [manager]);

  const handleToggleSound = useCallback(() => {
    setSoundEnabled(prev => !prev);
  }, [setSoundEnabled]);

  const handleAnswerQuestion = useCallback(
    (requestId: string, answers: string[][]) => manager.answerQuestion(requestId, answers),
    [manager]
  );

  const handleRejectQuestion = useCallback(
    (requestId: string) => manager.rejectQuestion(requestId),
    [manager]
  );

  const handleRespondToPermission = useCallback(
    (requestId: string, response: 'once' | 'always' | 'reject') =>
      manager.respondToPermission(requestId, response),
    [manager]
  );

  const handleAcceptSuggestion = useCallback(
    (requestId: string, index: number) => manager.acceptSuggestion(requestId, index),
    [manager]
  );

  const handleDismissSuggestion = useCallback(
    (requestId: string) => manager.dismissSuggestion(requestId),
    [manager]
  );

  const handleModeChange = useCallback(
    (mode: AgentMode) => {
      if (sessionConfig) setSessionConfig({ ...sessionConfig, mode });
    },
    [sessionConfig, setSessionConfig]
  );

  const handleModelChange = useCallback(
    (model: string) => {
      if (!sessionConfig) return;
      // Reset variant to first available (typically "none") when switching models if current is invalid
      const newModelVariants = modelOptions.find(m => m.id === model)?.variants ?? [];
      const validVariant =
        sessionConfig.variant && newModelVariants.includes(sessionConfig.variant)
          ? sessionConfig.variant
          : newModelVariants[0];
      setSessionConfig({ ...sessionConfig, model, variant: validVariant });
    },
    [sessionConfig, setSessionConfig, modelOptions]
  );

  const handleVariantChange = useCallback(
    (variant: string) => {
      if (sessionConfig) setSessionConfig({ ...sessionConfig, variant });
    },
    [sessionConfig, setSessionConfig]
  );

  // -- Delayed loading indicator (avoid flash for fast switches) ------------
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  useEffect(() => {
    if (!isLoading) {
      setShowLoadingIndicator(false);
      return;
    }
    const timer = setTimeout(() => setShowLoadingIndicator(true), 1000);
    return () => clearTimeout(timer);
  }, [isLoading]);

  // -- Derived state --------------------------------------------------------
  const showChatInterface = Boolean(sessionConfig) || Boolean(sessionIdFromParams);
  const currentModelOption = modelOptions.find(m => m.id === sessionConfig?.model);
  const modelDisplayName = currentModelOption?.name
    ? formatShortModelDisplayName(currentModelOption.name)
    : undefined;
  const availableVariants = currentModelOption?.variants ?? [];

  const placeholder = isLoading
    ? 'Loading session…'
    : cloudStatus?.type === 'preparing'
      ? 'Setting up environment…'
      : cloudStatus?.type === 'finalizing'
        ? 'Wrapping up…'
        : 'Ask anything…';

  const sessionActions = (
    <ChatHeader
      cloudAgentSessionId={sessionId ?? 'Starting session…'}
      kiloSessionId={sessionIdFromParams ?? undefined}
      organizationId={organizationId}
      repository={sessionConfig?.repository ?? ''}
      model={sessionConfig?.model}
      modelDisplayName={modelDisplayName}
      totalCost={totalCost}
      soundEnabled={soundEnabled}
      onToggleSound={handleToggleSound}
    />
  );

  // -- Render ---------------------------------------------------------------
  return (
    <QuestionContextProvider
      questionRequestIds={emptyQuestionRequestIds}
      cloudAgentSessionId={sessionId}
      organizationId={organizationId ?? null}
      answerQuestion={handleAnswerQuestion}
      rejectQuestion={handleRejectQuestion}
    >
      <PermissionContextProvider
        cloudAgentSessionId={sessionId}
        organizationId={organizationId ?? null}
        respondToPermission={handleRespondToPermission}
      >
        <SuggestionContextProvider
          acceptSuggestion={handleAcceptSuggestion}
          dismissSuggestion={handleDismissSuggestion}
        >
          <div className="flex h-full w-full flex-col overflow-hidden">
            <SetPageTitle
              title={fetchedSessionData?.title || sessionConfig?.repository || 'Cloud Agent'}
            >
              {totalCost > 0 && (
                <span className="text-muted-foreground text-sm">${totalCost.toFixed(4)}</span>
              )}
            </SetPageTitle>
            {showChatInterface ? (
              <>
                {showLoadingIndicator && <div className="bg-primary h-0.5 w-full animate-pulse" />}

                <div className="flex shrink-0 items-center justify-between border-b px-3 py-2 lg:hidden">
                  <MobileSidebarToggle variant="inline" label="Sessions" />
                  {sessionActions}
                </div>

                <div className="relative min-h-0 flex-1">
                  <div className="absolute right-3 top-2 z-10 hidden lg:block">
                    {sessionActions}
                  </div>

                  <div
                    ref={scrollContainerRef}
                    className={`absolute inset-0 overflow-y-auto px-[max(1rem,calc(50%_-_27rem))] pb-2 pt-4 transition-opacity duration-150 lg:pt-12 ${showLoadingIndicator ? 'pointer-events-none opacity-40' : 'opacity-100'}`}
                    onScroll={handleScroll}
                  >
                    <div ref={messagesContentRef}>
                      <StaticMessages
                        messages={staticMessages}
                        getChildMessages={getChildMessages}
                      />
                      <DynamicMessages
                        messages={dynamicMessages}
                        getChildMessages={getChildMessages}
                      />

                      <WorkingIndicator messages={dynamicMessages} isStreaming={isStreaming} />
                      {statusIndicator && <SessionStatusIndicator indicator={statusIndicator} />}

                      <div ref={messagesEndRef} />
                    </div>
                  </div>

                  {showScrollButton && (
                    <button
                      type="button"
                      onClick={scrollToBottom}
                      className="border-border bg-background absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border p-2 shadow-md"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {isReadOnly ? (
                  !isLoading && sessionIdFromParams && fetchedSessionData ? (
                    <SessionContinuationPanel sessionId={sessionIdFromParams} />
                  ) : null
                ) : (
                  <>
                    {activeQuestion && (
                      <div className="border-t px-[max(1rem,calc(50%_-_27rem))] py-4">
                        <QuestionToolCard
                          key={activeQuestion.requestId}
                          questions={activeQuestion.questions}
                          requestId={activeQuestion.requestId}
                          status="running"
                        />
                      </div>
                    )}
                    {activePermission && (
                      <div className="flex items-center border-t p-4">
                        <PermissionCard
                          key={activePermission.requestId}
                          requestId={activePermission.requestId}
                          permission={activePermission.permission}
                          patterns={activePermission.patterns}
                          metadata={activePermission.metadata}
                          always={activePermission.always}
                        />
                      </div>
                    )}
                    <div className={activeQuestion || activePermission ? 'hidden' : ''}>
                      <ChatInput
                        onSend={handleSendMessage}
                        onStop={handleStopExecution}
                        disabled={(isStreaming && !activeSuggestion) || !canSend}
                        isStreaming={isStreaming && !activeSuggestion}
                        placeholder={placeholder}
                        slashCommands={availableCommands}
                        mode={sessionConfig?.mode as AgentMode | undefined}
                        model={sessionConfig?.model}
                        modelOptions={modelOptions}
                        isLoadingModels={isLoadingModels}
                        onModeChange={handleModeChange}
                        onModelChange={handleModelChange}
                        variant={sessionConfig?.variant ?? undefined}
                        onVariantChange={handleVariantChange}
                        availableVariants={availableVariants}
                        showToolbar={Boolean(sessionIdFromParams)}
                        initialValue={failedPrompt ?? undefined}
                        imageUploadOptions={{
                          messageUuid: imageMessageUuid,
                          organizationId,
                          maxImages: CLOUD_AGENT_IMAGE_MAX_COUNT,
                          maxOriginalFileSizeBytes: CLOUD_AGENT_IMAGE_MAX_ORIGINAL_SIZE_BYTES,
                          maxFileSizeBytes: CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES,
                          allowedTypes: CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
                          resizeImages: { maxDimensionPx: CLOUD_AGENT_IMAGE_MAX_DIMENSION_PX },
                          getUploadUrl: {
                            personal: personalUploadUrl,
                            organization: orgUploadUrl,
                          },
                        }}
                      />
                      {sessionConfig?.repository && (
                        <div className="text-muted-foreground flex items-center gap-1.5 px-[max(1rem,calc(50%_-_27rem))] pb-3 text-xs md:pb-4">
                          <GitBranch className="h-3 w-3 shrink-0" />
                          <span className="truncate">{sessionConfig.repository}</span>
                          {fetchedSessionData?.gitBranch && (
                            <>
                              <span>·</span>
                              <span className="truncate">{fetchedSessionData.gitBranch}</span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="text-muted-foreground relative flex h-full flex-col items-center justify-center gap-2">
                <MobileSidebarToggle />
                <p className="text-sm">No active session</p>
                <p className="text-xs">Select a session from the sidebar or create a new one</p>
              </div>
            )}
          </div>
        </SuggestionContextProvider>
      </PermissionContextProvider>
    </QuestionContextProvider>
  );
}

export { CloudChatPage };

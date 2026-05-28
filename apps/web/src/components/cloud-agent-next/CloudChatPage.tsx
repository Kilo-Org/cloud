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
import type { ModeOption } from '@/components/shared/ModeCombobox';
import { MessageErrorBoundary } from './MessageErrorBoundary';
import { MessageBubble } from './MessageBubble';
import { ChildSessionDrawer } from './ChildSessionDrawer';
import type { ChildSessionDrawerEntry, OpenChildSession } from './ChildSessionSection';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { WorkingIndicator } from './WorkingIndicator';
import { QuestionToolCard } from './QuestionToolCard';
import { QuestionContextProvider } from './QuestionContext';
import { PermissionCard, PermissionContextProvider } from './PermissionCard';
import { SuggestionContextProvider } from './SuggestionCard';
import { SessionContinuationPanel } from './SessionContinuationPanel';
import { CloudAgentTerminalPane } from './CloudAgentTerminalDock';
import { CloudAgentWorkspaceTabs } from './CloudAgentWorkspaceTabs';
import {
  CHAT_TAB_ID,
  addTerminalTab,
  closeTerminalTab,
  createWorkspaceTabsState,
  resetWorkspaceTabs,
  selectWorkspaceTab,
  terminalTabId,
} from './terminal-tabs';
import { isMessageStreaming } from './types';
import { useOrganizationModels } from './hooks/useOrganizationModels';
import { useSlashCommandSets } from '@/hooks/useSlashCommandSets';
import { useCelebrationSound } from '@/hooks/useCelebrationSound';
import type { CloudAgentAttachments } from '@/lib/cloud-agent/constants';

import { SetPageTitle } from '@/components/SetPageTitle';
import { formatShortModelDisplayName } from '@/lib/format-model-name';
import type { AgentMode } from './types';
import type { MessageDeliveryState, StoredMessage } from '@/lib/cloud-agent-sdk';
import type { WorkspaceTabId } from './terminal-tabs';
import type { TerminalStatus } from './useCloudAgentTerminal';

// ---------------------------------------------------------------------------
// Static messages — memoized, never re-renders during streaming
// ---------------------------------------------------------------------------
const StaticMessages = memo(
  ({
    messages,
    pendingMessages,
    getChildMessages,
    onOpenChildSession,
  }: {
    messages: StoredMessage[];
    pendingMessages: ReadonlyMap<string, MessageDeliveryState>;
    getChildMessages?: (sessionId: string) => StoredMessage[];
    onOpenChildSession?: OpenChildSession;
  }) => (
    <>
      {messages.map(msg => (
        <MessageErrorBoundary key={msg.info.id}>
          <MessageBubble
            message={msg}
            deliveryState={pendingMessages.get(msg.info.id)}
            getChildMessages={getChildMessages}
            onOpenChildSession={onOpenChildSession}
          />
        </MessageErrorBoundary>
      ))}
    </>
  )
);
StaticMessages.displayName = 'StaticMessages';

// ---------------------------------------------------------------------------
// Dynamic messages — re-renders as streaming progresses while chat is visible
// ---------------------------------------------------------------------------
type DynamicMessagesProps = {
  active: boolean;
  messages: StoredMessage[];
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
};

const DynamicMessages = memo(
  function DynamicMessages({
    messages,
    pendingMessages,
    getChildMessages,
    onOpenChildSession,
  }: DynamicMessagesProps) {
    return (
      <>
        {messages.map(msg => {
          const streaming = isMessageStreaming(msg);
          return (
            <MessageErrorBoundary key={msg.info.id}>
              <MessageBubble
                message={msg}
                isStreaming={streaming}
                deliveryState={pendingMessages.get(msg.info.id)}
                getChildMessages={getChildMessages}
                onOpenChildSession={onOpenChildSession}
              />
            </MessageErrorBoundary>
          );
        })}
      </>
    );
  },
  (previous, next) => {
    if (!previous.active && !next.active) return true;

    return (
      previous.active === next.active &&
      previous.messages === next.messages &&
      previous.pendingMessages === next.pendingMessages &&
      previous.getChildMessages === next.getChildMessages &&
      previous.onOpenChildSession === next.onOpenChildSession
    );
  }
);
DynamicMessages.displayName = 'DynamicMessages';

// ---------------------------------------------------------------------------
// CloudChatPage
// ---------------------------------------------------------------------------
const emptyQuestionRequestIds = new Map<string, string>();

type CloudChatPageProps = { organizationId?: string };

type TerminalStatusSummary = { status: TerminalStatus; statusText: string };

function TerminalPaneSlot({
  terminalId,
  active,
  sessionId,
  organizationId,
  onStatusChange,
}: {
  terminalId: string;
  active: boolean;
  sessionId: string | null | undefined;
  organizationId?: string;
  onStatusChange: (terminalId: string, status: TerminalStatusSummary) => void;
}) {
  const handleStatusChange = useCallback(
    (status: TerminalStatusSummary) => onStatusChange(terminalId, status),
    [onStatusChange, terminalId]
  );

  return (
    <div className={active ? 'h-full min-h-0' : 'hidden'}>
      {sessionId && (
        <CloudAgentTerminalPane
          cloudAgentSessionId={sessionId}
          organizationId={organizationId}
          active={active}
          onStatusChange={handleStatusChange}
        />
      )}
    </div>
  );
}

export default function CloudChatPage({ organizationId }: CloudChatPageProps) {
  const manager = useManager();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { mutateAsync: personalUploadUrl } = useMutation(
    trpc.cloudAgentNext.getAttachmentUploadUrl.mutationOptions()
  );
  const { mutateAsync: orgUploadUrl } = useMutation(
    trpc.organizations.cloudAgentNext.getAttachmentUploadUrl.mutationOptions()
  );
  const [childSessionStack, setChildSessionStack] = useState<ChildSessionDrawerEntry[]>([]);
  const [childSessionDrawerContainer, setChildSessionDrawerContainer] =
    useState<HTMLDivElement | null>(null);
  const childSessionDrawerFocusTargetRef = useRef<HTMLElement | null>(null);

  // URL-driven session switching
  const sessionIdFromParams = searchParams?.get('sessionId');
  useEffect(() => {
    if (sessionIdFromParams) {
      childSessionDrawerFocusTargetRef.current = null;
      setChildSessionStack([]);
      void manager.switchSession(sessionIdFromParams as KiloSessionId);
    }
  }, [sessionIdFromParams, manager]);

  // -- Manager atoms --------------------------------------------------------
  const isStreaming = useAtomValue(manager.atoms.isStreaming);
  const isLoading = useAtomValue(manager.atoms.isLoading);
  const isReadOnly = useAtomValue(manager.atoms.isReadOnly);
  const supportsAttachments = useAtomValue(manager.atoms.supportsAttachments);
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
  const pendingMessages = useAtomValue(manager.atoms.pendingMessages);
  const totalCost = useAtomValue(manager.atoms.totalCost);
  const getChildMessages = useAtomValue(manager.atoms.childMessages);
  const fetchedSessionData = useAtomValue(manager.atoms.fetchedSessionData);

  const setSessionConfig = useSetAtom(manager.atoms.sessionConfig);

  const [attachmentMessageUuid] = useState(() => crypto.randomUUID());
  const [workspaceTabs, setWorkspaceTabs] = useState(createWorkspaceTabsState);
  const [terminalStatuses, setTerminalStatuses] = useState<
    Record<string, TerminalStatusSummary | undefined>
  >({});
  const chatTabActive = workspaceTabs.activeTabId === CHAT_TAB_ID;

  useEffect(() => {
    setWorkspaceTabs(resetWorkspaceTabs);
    setTerminalStatuses({});
  }, [sessionId]);

  // -- Organization models --------------------------------------------------
  const { modelOptions, isLoadingModels } = useOrganizationModels(organizationId);
  const { availableCommands } = useSlashCommandSets();

  // -- Sound effects --------------------------------------------------------
  const { play: playCelebrationSound, soundEnabled, setSoundEnabled } = useCelebrationSound();

  const prevActivityRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevActivityRef.current === 'busy' && activity.type === 'idle') {
      playCelebrationSound();
      void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
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
  const followUpAutoScrollFrameRef = useRef(0);
  const delayedAutoScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelScheduledAutoScroll = useCallback(() => {
    cancelAnimationFrame(autoScrollFrameRef.current);
    cancelAnimationFrame(followUpAutoScrollFrameRef.current);
    autoScrollFrameRef.current = 0;
    followUpAutoScrollFrameRef.current = 0;
    if (delayedAutoScrollRef.current !== null) {
      clearTimeout(delayedAutoScrollRef.current);
      delayedAutoScrollRef.current = null;
    }
  }, []);

  const scrollToBottomNow = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || el.hidden) return;

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
    cancelScheduledAutoScroll();

    autoScrollFrameRef.current = requestAnimationFrame(() => {
      autoScrollFrameRef.current = 0;
      scrollToBottomNow();
      followUpAutoScrollFrameRef.current = requestAnimationFrame(() => {
        followUpAutoScrollFrameRef.current = 0;
        scrollToBottomNow();
      });
      delayedAutoScrollRef.current = setTimeout(() => {
        delayedAutoScrollRef.current = null;
        scrollToBottomNow();
      }, 100);
    });
  }, [cancelScheduledAutoScroll, scrollToBottomNow]);

  useEffect(() => cancelScheduledAutoScroll, [cancelScheduledAutoScroll]);

  useEffect(() => {
    if (!chatTabActive) cancelScheduledAutoScroll();
  }, [cancelScheduledAutoScroll, chatTabActive]);

  useEffect(() => {
    if (!chatTabActive || !chatUI.shouldAutoScroll) return;
    scheduleScrollToBottom();
  }, [
    staticMessages,
    dynamicMessages,
    chatTabActive,
    chatUI.shouldAutoScroll,
    scheduleScrollToBottom,
  ]);

  useEffect(() => {
    if (!chatTabActive || !chatUI.shouldAutoScroll) return;
    if (typeof ResizeObserver === 'undefined') return;

    const content = messagesContentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      scheduleScrollToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [chatTabActive, chatUI.shouldAutoScroll, scheduleScrollToBottom]);

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
    async (prompt: string, attachments?: CloudAgentAttachments) => {
      setChatUI({ shouldAutoScroll: true });
      const selectedRuntimeAgentForSend = sessionConfig?.runtimeAgents?.find(
        a => a.slug === sessionConfig?.mode
      );
      const agentModelOverrideForSend = selectedRuntimeAgentForSend?.model?.trim() || undefined;
      // An agent's variant only applies when it also pins a model — variants
      // are model-specific (validated at write time in AgentConfigSchema). When
      // an agent pins a model, its variant (if any) wins; otherwise the
      // user-selected session variant applies.
      const agentVariantOverrideForSend = agentModelOverrideForSend
        ? selectedRuntimeAgentForSend?.variant?.trim() || undefined
        : undefined;
      const acceptedPromise = manager.send({
        payload: {
          type: 'prompt',
          prompt,
          mode: sessionConfig?.mode ?? 'code',
          model: agentModelOverrideForSend ?? sessionConfig?.model ?? '',
          variant: agentModelOverrideForSend
            ? agentVariantOverrideForSend
            : (sessionConfig?.variant ?? undefined),
        },
        attachments: supportsAttachments ? attachments : undefined,
      });
      scheduleScrollToBottom();

      const accepted = await acceptedPromise;
      if (accepted) {
        scheduleScrollToBottom();
      }
      return accepted;
    },
    [manager, scheduleScrollToBottom, sessionConfig, setChatUI, supportsAttachments]
  );

  const handleSendSlashCommand = useCallback(
    async (command: string, args: string, attachments?: CloudAgentAttachments) => {
      setChatUI({ shouldAutoScroll: true });
      const acceptedPromise = manager.send({
        payload: { type: 'command', command, arguments: args },
        attachments: supportsAttachments ? attachments : undefined,
      });
      scheduleScrollToBottom();
      const accepted = await acceptedPromise;
      if (accepted) {
        scheduleScrollToBottom();
      }
      return accepted;
    },
    [manager, scheduleScrollToBottom, setChatUI, supportsAttachments]
  );

  const handleStopExecution = useCallback(() => {
    void manager.interrupt();
  }, [manager]);

  const handleToggleSound = useCallback(() => {
    setSoundEnabled(prev => !prev);
  }, [setSoundEnabled]);

  const handleCreateTerminalTab = useCallback(() => {
    const terminalId = crypto.randomUUID();
    setWorkspaceTabs(state => addTerminalTab(state, terminalId));
  }, []);

  const handleSelectWorkspaceTab = useCallback((tabId: WorkspaceTabId) => {
    setWorkspaceTabs(state => selectWorkspaceTab(state, tabId));
  }, []);

  const handleCloseTerminalTab = useCallback((terminalId: string) => {
    setWorkspaceTabs(state => closeTerminalTab(state, terminalId));
    setTerminalStatuses(current => {
      const next = { ...current };
      delete next[terminalId];
      return next;
    });
  }, []);

  const handleTerminalStatusChange = useCallback(
    (terminalId: string, status: TerminalStatusSummary) => {
      setTerminalStatuses(current => ({ ...current, [terminalId]: status }));
    },
    []
  );

  const terminalPaneMap = workspaceTabs.terminals.map(tab => {
    const active = terminalTabId(tab.id) === workspaceTabs.activeTabId;
    return (
      <TerminalPaneSlot
        key={tab.id}
        terminalId={tab.id}
        active={active}
        sessionId={sessionId}
        organizationId={organizationId}
        onStatusChange={handleTerminalStatusChange}
      />
    );
  });

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

  const handleOpenTopLevelChildSession = useCallback((entry: ChildSessionDrawerEntry) => {
    const activeElement = document.activeElement;
    childSessionDrawerFocusTargetRef.current =
      activeElement instanceof HTMLElement ? activeElement : null;
    setChildSessionStack([entry]);
  }, []);

  const handleOpenNestedChildSession = useCallback((entry: ChildSessionDrawerEntry) => {
    setChildSessionStack(currentStack => [...currentStack, entry]);
  }, []);

  const handleChildSessionDrawerBack = useCallback(() => {
    setChildSessionStack(currentStack => currentStack.slice(0, -1));
  }, []);

  const handleChildSessionDrawerOpenChange = useCallback((open: boolean) => {
    if (!open) setChildSessionStack([]);
  }, []);

  const handleChildSessionDrawerCloseAutoFocus = useCallback((event: Event) => {
    const focusTarget = childSessionDrawerFocusTargetRef.current;
    childSessionDrawerFocusTargetRef.current = null;
    if (!focusTarget?.isConnected) return;
    event.preventDefault();
    focusTarget.focus();
  }, []);

  // Expose the session's custom agents to the chat picker. Slug + name only;
  // the full config stays server-side. `GetSessionOutput.runtimeAgents`
  // already filters to enabled & non-hidden at send time, so we just pass
  // through.
  const customModeOptions: ModeOption<AgentMode>[] | undefined = sessionConfig?.runtimeAgents
    ?.length
    ? sessionConfig.runtimeAgents.map(a => ({
        value: a.slug as AgentMode,
        label: a.name,
        description: '',
      }))
    : undefined;

  // If the selected custom agent pins a model, the chat model picker must
  // reflect + lock that value. The agent's `variant` is only meaningful when
  // it also pins a model (variants are model-specific, validated at write
  // time in AgentConfigSchema), so we surface it alongside the locked model.
  const selectedRuntimeAgent = sessionConfig?.runtimeAgents?.find(
    a => a.slug === sessionConfig?.mode
  );
  const agentModelOverride = selectedRuntimeAgent?.model?.trim() || undefined;
  const agentVariantOverride = agentModelOverride
    ? selectedRuntimeAgent?.variant?.trim() || undefined
    : undefined;
  const displayModel = agentModelOverride ?? sessionConfig?.model;
  const modelPickerLocked = !!agentModelOverride;
  const lockTooltip = modelPickerLocked
    ? `Locked by agent "${selectedRuntimeAgent?.name}"`
    : undefined;

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
  // When an agent locks the model, swap the user's session variant for the
  // agent's variant (which may be undefined — i.e. no thinking-effort chip).
  // The variant picker is hidden in that case; it only shows when the user is
  // free to pick their own model.
  const displayVariant = modelPickerLocked
    ? agentVariantOverride
    : (sessionConfig?.variant ?? undefined);
  const displayAvailableVariants = modelPickerLocked ? [] : availableVariants;

  const placeholder = isLoading
    ? 'Loading session…'
    : cloudStatus?.type === 'preparing'
      ? 'Setting up environment…'
      : cloudStatus?.type === 'finalizing'
        ? 'Wrapping up…'
        : 'Ask anything…';

  const canOpenTerminal = Boolean(sessionId) && !isReadOnly;

  const sessionActions = (
    <ChatHeader
      cloudAgentSessionId={sessionId ?? 'Starting session…'}
      kiloSessionId={sessionIdFromParams ?? undefined}
      organizationId={organizationId}
      repository={sessionConfig?.repository ?? ''}
      branch={fetchedSessionData?.gitBranch ?? undefined}
      gitUrl={fetchedSessionData?.gitUrl}
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

                <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
                  <MobileSidebarToggle variant="inline" label="Sessions" />
                  <div className="min-w-0 flex-1">
                    {canOpenTerminal && (
                      <CloudAgentWorkspaceTabs
                        activeTabId={workspaceTabs.activeTabId}
                        terminals={workspaceTabs.terminals}
                        terminalStatuses={terminalStatuses}
                        canCreateTerminal={canOpenTerminal}
                        onSelectTab={handleSelectWorkspaceTab}
                        onCreateTerminal={handleCreateTerminalTab}
                        onCloseTerminal={handleCloseTerminalTab}
                      />
                    )}
                  </div>
                  <div className="shrink-0">{sessionActions}</div>
                </div>

                <div
                  ref={setChildSessionDrawerContainer}
                  className="relative flex min-h-0 flex-1 flex-col"
                >
                  <div
                    inert={childSessionStack.length > 0}
                    className="flex min-h-0 flex-1 flex-col"
                  >
                    <div className="relative min-h-0 flex-1">
                      <>
                        <div
                          ref={scrollContainerRef}
                          hidden={!chatTabActive}
                          className={`absolute inset-0 overflow-y-auto px-[max(1rem,calc(50%_-_27rem))] pb-2 pt-4 transition-opacity duration-150 ${showLoadingIndicator ? 'pointer-events-none opacity-40' : 'opacity-100'}`}
                          onScroll={handleScroll}
                        >
                          <div ref={messagesContentRef}>
                            <StaticMessages
                              messages={staticMessages}
                              pendingMessages={pendingMessages}
                              getChildMessages={getChildMessages}
                              onOpenChildSession={handleOpenTopLevelChildSession}
                            />
                            <DynamicMessages
                              active={chatTabActive}
                              messages={dynamicMessages}
                              pendingMessages={pendingMessages}
                              getChildMessages={getChildMessages}
                              onOpenChildSession={handleOpenTopLevelChildSession}
                            />

                            {chatTabActive && (
                              <WorkingIndicator
                                messages={dynamicMessages}
                                isStreaming={isStreaming}
                              />
                            )}
                            {statusIndicator && (
                              <SessionStatusIndicator indicator={statusIndicator} />
                            )}

                            <div ref={messagesEndRef} />
                          </div>
                        </div>

                        {chatTabActive && showScrollButton && (
                          <button
                            type="button"
                            onClick={scrollToBottom}
                            className="border-border bg-background absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border p-2 shadow-md"
                          >
                            <ArrowDown className="h-4 w-4" />
                          </button>
                        )}
                      </>

                      <div
                        className={
                          chatTabActive
                            ? 'hidden'
                            : 'h-full min-h-0 px-[max(1rem,calc(50%_-_27rem))] py-2'
                        }
                      >
                        {terminalPaneMap}
                      </div>
                    </div>

                    {chatTabActive && (
                      <>
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
                                onSendCommand={handleSendSlashCommand}
                                onStop={handleStopExecution}
                                disabled={!canSend}
                                isStreaming={isStreaming && !activeSuggestion}
                                placeholder={placeholder}
                                slashCommands={availableCommands}
                                mode={sessionConfig?.mode as AgentMode | undefined}
                                model={displayModel}
                                modelOptions={modelOptions}
                                isLoadingModels={isLoadingModels}
                                onModeChange={handleModeChange}
                                onModelChange={handleModelChange}
                                variant={displayVariant}
                                onVariantChange={handleVariantChange}
                                availableVariants={displayAvailableVariants}
                                showToolbar={Boolean(sessionIdFromParams)}
                                initialValue={failedPrompt ?? undefined}
                                customModeOptions={customModeOptions}
                                modelPickerDisabled={modelPickerLocked}
                                modelPickerTooltip={lockTooltip}
                                variantPickerDisabled={modelPickerLocked}
                                variantPickerTooltip={lockTooltip}
                                attachmentsEnabled={supportsAttachments}
                                attachmentUploadOptions={{
                                  messageUuid: attachmentMessageUuid,
                                  organizationId,
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
                                      <span className="truncate">
                                        {fetchedSessionData.gitBranch}
                                      </span>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-muted-foreground relative flex h-full flex-col items-center justify-center gap-2">
                <MobileSidebarToggle />
                <p className="text-sm">No active session</p>
                <p className="text-xs">Select a session from the sidebar or create a new one</p>
              </div>
            )}
            <ChildSessionDrawer
              stack={childSessionStack}
              onBack={handleChildSessionDrawerBack}
              onOpenChange={handleChildSessionDrawerOpenChange}
              onOpenChildSession={handleOpenNestedChildSession}
              onCloseAutoFocus={handleChildSessionDrawerCloseAutoFocus}
              portalContainer={childSessionDrawerContainer}
            />
          </div>
        </SuggestionContextProvider>
      </PermissionContextProvider>
    </QuestionContextProvider>
  );
}

export { CloudChatPage };

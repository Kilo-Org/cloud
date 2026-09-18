'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { ArrowDown, GitBranch, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { v4 as uuidv4 } from 'uuid';

import type { KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { useCloudAgent, useManager } from './CloudAgentProvider';
import { useWorktreeChatCreation, useWorktreeChatTabs } from './CloudSidebarLayout';
import { MobileSidebarToggle } from './MobileSidebarToggle';
import { ChatHeader } from './ChatHeader';
import { isSandboxStatusEligible } from './sandbox-status';
import { ChatInput } from './ChatInput';
import {
  dedupeCustomModeOptions,
  ensureSelectedCustomOption,
  modeControlValue,
  normalizeAlias,
  type CustomModeOption,
} from './session-config';
import { useCombinedProfiles, useProfiles, useProfile } from '@/hooks/useCloudAgentProfiles';
import {
  formatSessionCost,
  getSessionCostBreakdown,
  getSessionTotalCostUsd,
  isRenderableSessionCost,
} from './session-cost-breakdown';
import { ConversationMessages } from './ConversationMessages';
import { planResumeAttempt, resumeAnchorForTranscript, sendTakesOverResume } from './resume-anchor';
import { ChildSessionDrawer } from './ChildSessionDrawer';
import type { ChildSessionDrawerEntry } from './ChildSessionSection';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { isNoOpCompletedPreparationAttempt } from './preparation-summary';
import { PreparationDrawer } from './PreparationDrawer';
import { WorkingIndicator } from './WorkingIndicator';
import { QuestionToolCard } from './QuestionToolCard';
import { QuestionContextProvider } from './QuestionContext';
import { PermissionCard, PermissionContextProvider } from './PermissionCard';
import { SuggestionContextProvider } from './SuggestionCard';
import { SessionContinuationPanel } from './SessionContinuationPanel';
import { CloudAgentTerminalPane } from './CloudAgentTerminalDock';
import { CloudAgentBillingError } from './CloudAgentBillingError';
import { OlderMessagesHeader } from './OlderMessagesHeader';
import {
  OLDER_MESSAGES_NEAR_BOTTOM_PX,
  shouldAnnounceOlderMessagesArrival,
  useOlderMessagesPagination,
} from './older-messages-scroll';
import { billingPayerPresentation } from './billing-payer-presentation';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { CloudAgentWorkspaceTabs } from './CloudAgentWorkspaceTabs';
import { WorktreeChangesDrawer } from './WorktreeChanges';
import { WorktreeFilePane } from './WorktreeFilePane';
import { commitsByMessageAnchor, isCommitSummaryRepresented } from './message-presentation';
import { WorktreeReviewDialog } from './WorktreeReviewDialog';
import { useWorktreeReview } from './useWorktreeReview';
import type { WorktreeReviewComment } from './worktree-review';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { canOpenWorktreeChanges } from './worktree-changes';
import {
  CHAT_TAB_ID,
  addTerminalTab,
  clearFileTabs,
  closeFileTab,
  closeTerminalTab,
  createWorkspaceTabsState,
  fileTabId,
  getWorkspaceTabScope,
  openFileTab,
  resetWorkspaceTabs,
  selectWorkspaceTab,
  setFileTabMode,
  terminalIdFromTabId,
  terminalTabId,
} from './workspace-tabs';
import {
  createRemoteModelOverride,
  useSessionModels,
  validateRemoteModelOverride,
} from './hooks/useSessionModels';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import { resolveContextWindow } from './model-context-lengths';
import { useSlashCommandSets } from '@/hooks/useSlashCommandSets';
import { useCelebrationSound } from '@/hooks/useCelebrationSound';
import { useCliSessionPresence } from '@/hooks/useCliSessionPresence';
import type { CloudAgentAttachments } from '@/lib/cloud-agent/constants';

import { SetPageTitle } from '@/components/SetPageTitle';
import { formatShortModelDisplayName } from '@/lib/format-model-name';
import type { AgentMode } from './types';
import type { PreparationAttempt } from '@kilocode/cloud-agent-sdk';
import type { WorkspaceTabId } from './workspace-tabs';
import type { TerminalStatus } from './useCloudAgentTerminal';

// ---------------------------------------------------------------------------
// CloudChatPage
// ---------------------------------------------------------------------------
const emptyQuestionRequestIds = new Map<string, string>();

/** Older pages the resume fetches while looking for a not-yet-loaded anchor. */
const MAX_RESUME_OLDER_PAGES = 8;

type ResumeState = {
  key: string;
  attempts: number;
  done: boolean;
};

/** The rendered element carrying `messageId`, when it is in the DOM. */
function findMessageElement(container: HTMLElement, messageId: string): HTMLElement | null {
  for (const element of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (element.dataset.messageId === messageId) return element;
  }
  return null;
}

/**
 * The scroll target for a resolved anchor: the first of the anchor's candidate
 * ids that is in the DOM. A group can render no element at all — an
 * all-invisible assistant turn draws nothing — and such a group is invisible by
 * design, so the anchor falls to the nearest rendered group after it instead of
 * looking like an unloaded message. Every probed group is already in the loaded
 * window, so a hit never needs an older page.
 */
function findAnchorElement(
  container: HTMLElement,
  selectorIds: readonly string[]
): HTMLElement | null {
  for (const selectorId of selectorIds) {
    const element = findMessageElement(container, selectorId);
    if (element) return element;
  }
  return null;
}

type CloudChatPageProps = {
  currentUserId?: string;
  organizationId?: string;
  organizationName?: string;
  organizationRole?: OrganizationRole;
};

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

export default function CloudChatPage({
  currentUserId,
  organizationId,
  organizationName,
  organizationRole,
}: CloudChatPageProps) {
  const manager = useManager();
  const reviewApi = useCloudAgent();
  const { createWorktreeChat, creatingWorktreeSourceSessionId } = useWorktreeChatCreation();
  const {
    selectedWorktreeId,
    worktreeChats,
    openWorktreeChats,
    closedWorktreeChats,
    openSession,
    closeSession,
    renameSession,
    deletingSessionIds,
  } = useWorktreeChatTabs();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { mutateAsync: personalUploadUrl } = useMutation(
    trpc.cloudAgentNext.getAttachmentUploadUrl.mutationOptions()
  );
  const { mutateAsync: orgUploadUrl } = useMutation(
    trpc.organizations.cloudAgentNext.getAttachmentUploadUrl.mutationOptions()
  );
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const sessionInfoTriggerRef = useRef<HTMLElement | null>(null);
  const [childSessionStack, setChildSessionStack] = useState<ChildSessionDrawerEntry[]>([]);
  const [childSessionDrawerContainer, setChildSessionDrawerContainer] =
    useState<HTMLDivElement | null>(null);
  const childSessionDrawerFocusTargetRef = useRef<HTMLElement | null>(null);
  const [preparationDrawerAttemptId, setPreparationDrawerAttemptId] = useState<string | null>(null);
  const preparationDrawerFocusTargetRef = useRef<HTMLElement | null>(null);
  const [changesDrawerSessionId, setChangesDrawerSessionId] = useState<string | null>(null);
  const changesDrawerFocusTargetRef = useRef<HTMLElement | 'workspace-tab' | null>(null);
  const activeWorkspaceTabRef = useRef<HTMLButtonElement | null>(null);

  // URL-driven session switching
  const sessionIdFromParams = searchParams?.get('sessionId') ?? null;
  const anchorMessageIdFromParams = searchParams?.get('at') ?? null;
  useEffect(() => {
    childSessionDrawerFocusTargetRef.current = null;
    setChildSessionStack([]);
    preparationDrawerFocusTargetRef.current = null;
    setPreparationDrawerAttemptId(null);
    changesDrawerFocusTargetRef.current = null;
    setChangesDrawerSessionId(null);
    if (sessionIdFromParams) {
      void manager.switchSession(sessionIdFromParams as KiloSessionId);
    } else {
      manager.destroy();
    }
  }, [sessionIdFromParams, manager]);

  // -- Manager atoms --------------------------------------------------------
  const isStreaming = useAtomValue(manager.atoms.isStreaming);
  const isLoading = useAtomValue(manager.atoms.isLoading);
  const isReadOnly = useAtomValue(manager.atoms.isReadOnly);
  const supportsAttachments = useAtomValue(manager.atoms.supportsAttachments);
  const canSend = useAtomValue(manager.atoms.canSend);
  const statusIndicator = useAtomValue(manager.atoms.statusIndicator);
  const billingFailure = useAtomValue(manager.atoms.billingFailure);
  const sessionConfig = useAtomValue(manager.atoms.sessionConfig);
  const sessionId = useAtomValue(manager.atoms.sessionId);
  const activity = useAtomValue(manager.atoms.activity);
  const cloudStatus = useAtomValue(manager.atoms.cloudStatus);
  const preparationAttempts = useAtomValue(manager.atoms.preparationAttempts);
  const commits = useAtomValue(manager.atoms.commits);
  const activeQuestion = useAtomValue(manager.atoms.activeQuestion);
  const activePermission = useAtomValue(manager.atoms.activePermission);
  const activeSuggestion = useAtomValue(manager.atoms.activeSuggestion);
  const failedPrompt = useAtomValue(manager.atoms.failedPrompt);
  const staticMessages = useAtomValue(manager.atoms.staticMessages);
  const dynamicMessages = useAtomValue(manager.atoms.dynamicMessages);
  const pendingMessages = useAtomValue(manager.atoms.pendingMessages);
  const liveTotalCostUsd = useAtomValue(manager.atoms.totalCost);
  const contextUsage = useAtomValue(manager.atoms.contextUsage);
  const getChildMessages = useAtomValue(manager.atoms.childMessages);
  const fetchedSessionData = useAtomValue(manager.atoms.fetchedSessionData);
  const activeSessionType = useAtomValue(manager.atoms.activeSessionType);
  const remoteModelState = useAtomValue(manager.atoms.remoteModelState);
  const observedModel = useAtomValue(manager.atoms.observedModel);
  const remoteModelOverride = useAtomValue(manager.atoms.remoteModelOverride);
  const hasOlderMessages = useAtomValue(manager.atoms.hasOlderMessages);
  const isLoadingOlderMessages = useAtomValue(manager.atoms.isLoadingOlderMessages);
  const olderMessagesError = useAtomValue(manager.atoms.olderMessagesError);
  const olderMessagesOmittedItemCount = useAtomValue(manager.atoms.olderMessagesOmittedItemCount);
  const isCurrentSession =
    sessionIdFromParams === null || fetchedSessionData?.kiloSessionId === sessionIdFromParams;
  const totalCostUsd = isCurrentSession
    ? getSessionTotalCostUsd(fetchedSessionData?.totalCostMicrodollars, liveTotalCostUsd)
    : 0;
  const getCurrentSessionCostBreakdown = useCallback(
    () =>
      getSessionCostBreakdown(
        isCurrentSession ? [...staticMessages, ...dynamicMessages] : [],
        isCurrentSession ? fetchedSessionData?.totalCostMicrodollars : null,
        isCurrentSession ? liveTotalCostUsd : 0
      ),
    [
      dynamicMessages,
      fetchedSessionData?.totalCostMicrodollars,
      isCurrentSession,
      liveTotalCostUsd,
      staticMessages,
    ]
  );

  useCliSessionPresence(fetchedSessionData?.kiloSessionId ?? null);

  const setSessionConfig = useSetAtom(manager.atoms.sessionConfig);

  const [attachmentMessageUuid] = useState(() => uuidv4());
  const [workspaceTabs, setWorkspaceTabs] = useState(createWorkspaceTabsState);
  const [terminalStatuses, setTerminalStatuses] = useState<
    Record<string, TerminalStatusSummary | undefined>
  >({});
  const preserveTerminalSelectionRef = useRef(false);
  const workspaceTabScope = getWorkspaceTabScope(selectedWorktreeId, sessionIdFromParams);
  const workspaceIdentityResolved =
    !sessionIdFromParams ||
    selectedWorktreeId !== null ||
    (fetchedSessionData?.kiloSessionId === sessionIdFromParams &&
      fetchedSessionData.organizationId === (organizationId ?? null));
  const [resolvedWorkspaceScope, setResolvedWorkspaceScope] = useState({
    currentUserId,
    organizationId,
    scope: workspaceTabScope,
  });
  const canOpenChanges =
    sessionIdFromParams !== null &&
    isCurrentSession &&
    canOpenWorktreeChanges(sessionId, isReadOnly) &&
    fetchedSessionData?.organizationId === (organizationId ?? null);
  const changesDrawerOpen = canOpenChanges && changesDrawerSessionId === sessionId;
  const fileScope = JSON.stringify([currentUserId, organizationId, sessionIdFromParams, sessionId]);
  const [resolvedFileScope, setResolvedFileScope] = useState(fileScope);
  const filesVisible = canOpenChanges && resolvedFileScope === fileScope;
  const commitsAfterMessage = useMemo(
    () =>
      commitsByMessageAnchor([...staticMessages, ...dynamicMessages], filesVisible ? commits : []),
    [commits, dynamicMessages, filesVisible, staticMessages]
  );
  const activeWorkspaceTabId =
    !filesVisible && workspaceTabs.activeTabId.startsWith('file:')
      ? CHAT_TAB_ID
      : workspaceTabs.activeTabId;
  const chatTabValue =
    selectedWorktreeId && sessionIdFromParams ? `chat:${sessionIdFromParams}` : CHAT_TAB_ID;
  const chatTabActive =
    activeWorkspaceTabId === CHAT_TAB_ID &&
    (sessionIdFromParams !== null || selectedWorktreeId === null);
  const terminalTabActive = terminalIdFromTabId(activeWorkspaceTabId) !== null;

  if (resolvedFileScope !== fileScope) {
    setResolvedFileScope(fileScope);
    setWorkspaceTabs(clearFileTabs);
  }

  if (
    resolvedWorkspaceScope.currentUserId !== currentUserId ||
    resolvedWorkspaceScope.organizationId !== organizationId ||
    (workspaceIdentityResolved && resolvedWorkspaceScope.scope !== workspaceTabScope)
  ) {
    setResolvedWorkspaceScope({
      currentUserId,
      organizationId,
      scope: workspaceIdentityResolved ? workspaceTabScope : null,
    });
    setWorkspaceTabs(resetWorkspaceTabs);
    setTerminalStatuses({});
  }

  useEffect(() => {
    if (preserveTerminalSelectionRef.current) {
      preserveTerminalSelectionRef.current = false;
      return;
    }
    if (sessionIdFromParams) {
      setWorkspaceTabs(state => selectWorkspaceTab(state, CHAT_TAB_ID));
    }
  }, [sessionIdFromParams]);

  useEffect(() => {
    changesDrawerFocusTargetRef.current = null;
    setChangesDrawerSessionId(null);
  }, [sessionId, currentUserId, organizationId, canOpenChanges]);

  // -- Session models -------------------------------------------------------
  const sessionModels = useSessionModels({
    activeSessionType,
    remoteModelState,
    observedModel,
    remoteModelOverride,
    gatewayModelId: sessionConfig?.model,
    gatewayVariant: sessionConfig?.variant,
    fetchedSessionData,
    routeOrganizationId: organizationId,
    sessionIdFromParams,
  });
  const { modelOptions, isLoadingModels } = sessionModels;

  useEffect(() => {
    if (sessionModels.source !== 'remote-legacy-gateway' || isLoadingModels) return;

    const validatedOverride = validateRemoteModelOverride(
      remoteModelOverride,
      modelOptions,
      'legacy-gateway'
    );
    if (validatedOverride !== remoteModelOverride) {
      manager.setRemoteModelOverride(validatedOverride);
    }
  }, [isLoadingModels, manager, modelOptions, remoteModelOverride, sessionModels.source]);

  const contextWindow = resolveContextWindow(
    contextUsage,
    sessionModels.gatewayContextLengthByModelId,
    sessionModels.remoteContextLengthByProviderAndModel
  );
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
  // Mirrors `chatUI.shouldAutoScroll` so a scroll already scheduled (rAF or
  // timeout) re-checks the latest intent when it runs, not the value captured
  // when it was scheduled. The resume sets this false synchronously, before the
  // atom update lands, so an in-flight auto-scroll cannot override the anchor.
  const shouldAutoScrollRef = useRef(true);
  const wasNearBottomRef = useRef(true);
  const olderArrivalInitializedRef = useRef(false);
  const olderArrivalCountRef = useRef(0);
  const olderArrivalNewestKeyRef = useRef<string | null>(null);
  const [olderArrivalAnnouncement, setOlderArrivalAnnouncement] = useState('');
  const resumeStateRef = useRef<ResumeState | null>(null);

  const loadOlderMessages = useCallback(() => manager.loadOlderMessages(), [manager]);
  const { requestOlderMessages, tryLoadOlderFromScroll } = useOlderMessagesPagination({
    scrollElementRef: scrollContainerRef,
    hasOlderMessages,
    isLoadingOlderMessages,
    olderMessagesError,
    onLoad: loadOlderMessages,
    isProgrammaticScrollRef: isAutoScrollingRef,
    lastScrollTopRef,
    resetKey: sessionIdFromParams,
    overflowCheckKey: `${chatTabActive}:${staticMessages.length + dynamicMessages.length}`,
  });

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
    if (!shouldAutoScrollRef.current) return;

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
    if (!shouldAutoScrollRef.current) return;

    cancelScheduledAutoScroll();

    autoScrollFrameRef.current = requestAnimationFrame(() => {
      autoScrollFrameRef.current = 0;
      if (!shouldAutoScrollRef.current) return;
      scrollToBottomNow();
      followUpAutoScrollFrameRef.current = requestAnimationFrame(() => {
        followUpAutoScrollFrameRef.current = 0;
        if (shouldAutoScrollRef.current) scrollToBottomNow();
      });
      delayedAutoScrollRef.current = setTimeout(() => {
        delayedAutoScrollRef.current = null;
        if (shouldAutoScrollRef.current) scrollToBottomNow();
      }, 100);
    });
  }, [cancelScheduledAutoScroll, scrollToBottomNow]);

  useEffect(() => cancelScheduledAutoScroll, [cancelScheduledAutoScroll]);

  useEffect(() => {
    // An in-progress resume has already paused auto-scroll and owns the
    // position; do not let an atom write (e.g. a session reset) re-enable it.
    const resumeState = resumeStateRef.current;
    if (resumeState && !resumeState.done) return;
    shouldAutoScrollRef.current = chatUI.shouldAutoScroll;
  }, [chatUI.shouldAutoScroll]);

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

    // A `?at=` link's resume owns the opening position. Leave auto-scroll paused
    // for it instead of snapping to the bottom, which would override the anchor.
    const resuming = Boolean(anchorMessageIdFromParams);
    if (!resuming) {
      shouldAutoScrollRef.current = true;
      setChatUI({ shouldAutoScroll: true });
    }
    lastScrollTopRef.current = 0;
    wasNearBottomRef.current = true;
    olderArrivalInitializedRef.current = false;
    olderArrivalCountRef.current = 0;
    olderArrivalNewestKeyRef.current = null;
    setOlderArrivalAnnouncement('');
    setShowScrollButton(false);
    if (!resuming) scheduleScrollToBottom();
  }, [anchorMessageIdFromParams, sessionIdFromParams, setChatUI, scheduleScrollToBottom]);

  useEffect(() => {
    const newest = dynamicMessages.at(-1)?.info.id ?? staticMessages.at(-1)?.info.id ?? null;
    const nextCount = staticMessages.length + dynamicMessages.length;
    if (
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: olderArrivalInitializedRef.current,
        previousCount: olderArrivalCountRef.current,
        nextCount,
        previousNewestKey: olderArrivalNewestKeyRef.current,
        nextNewestKey: newest,
      })
    ) {
      setOlderArrivalAnnouncement('Earlier messages loaded');
    }
    olderArrivalInitializedRef.current = true;
    olderArrivalCountRef.current = nextCount;
    olderArrivalNewestKeyRef.current = newest;
  }, [dynamicMessages, staticMessages]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollButton(distanceFromBottom > 20);

    if (isAutoScrollingRef.current) {
      lastScrollTopRef.current = el.scrollTop;
      return;
    }

    // A real user scroll takes over from a resume that is still looking for its
    // anchor, so the transcript stops moving under the user.
    const resumeState = resumeStateRef.current;
    if (resumeState && !resumeState.done) {
      resumeState.done = true;
    }

    const scrolledUp = el.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;

    if (scrolledUp) {
      shouldAutoScrollRef.current = false;
      setChatUI({ shouldAutoScroll: false });
    } else if (distanceFromBottom < OLDER_MESSAGES_NEAR_BOTTOM_PX) {
      shouldAutoScrollRef.current = true;
      setChatUI({ shouldAutoScroll: true });
    }

    tryLoadOlderFromScroll(el.scrollTop);

    const isNearBottom = distanceFromBottom < OLDER_MESSAGES_NEAR_BOTTOM_PX;
    if (isNearBottom && !wasNearBottomRef.current) {
      manager.trimRetainedHistory();
    }
    wasNearBottomRef.current = isNearBottom;
  }, [manager, setChatUI, tryLoadOlderFromScroll]);

  const scrollToBottom = useCallback(() => {
    shouldAutoScrollRef.current = true;
    setChatUI({ shouldAutoScroll: true });
    scheduleScrollToBottom();
  }, [scheduleScrollToBottom, setChatUI]);

  // -- Handlers -------------------------------------------------------------
  const worktreeChatSourceSessionId = sessionIdFromParams
    ? activeSessionType === 'cloud-agent' &&
      fetchedSessionData?.worktreeId &&
      fetchedSessionData.kiloSessionId === sessionIdFromParams
      ? sessionIdFromParams
      : null
    : (worktreeChats[0]?.sessionId ?? null);
  const canCreateWorktreeChat = worktreeChatSourceSessionId !== null;
  const handleCreateWorktreeChat = useCallback(async () => {
    if (!worktreeChatSourceSessionId) return false;
    return createWorktreeChat(worktreeChatSourceSessionId);
  }, [createWorktreeChat, worktreeChatSourceSessionId]);
  const handleReplaceWorktreeChat = useCallback(async () => {
    if (!canCreateWorktreeChat || !sessionIdFromParams) return false;
    return createWorktreeChat(sessionIdFromParams, 'replace');
  }, [canCreateWorktreeChat, createWorktreeChat, sessionIdFromParams]);

  const handleSendMessage = useCallback(
    async (prompt: string, attachments?: CloudAgentAttachments) => {
      // Sending takes the position over only once the send is accepted: end a
      // resume that is still looking for its anchor, or its effect re-pauses
      // follow and cancels this scroll when the message lands. A rejected send
      // produces no output, so the resume keeps the position instead of being
      // abandoned at the bottom.
      const resumeStateAtSend = resumeStateRef.current;
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
          mode: normalizeAlias(sessionConfig?.mode) || 'code',
          model: agentModelOverrideForSend ?? sessionConfig?.model ?? '',
          variant: agentModelOverrideForSend
            ? agentVariantOverrideForSend
            : (sessionConfig?.variant ?? undefined),
        },
        attachments: supportsAttachments ? attachments : undefined,
      });
      // Pins the tail when the list already follows. While a resume has the
      // follow off this is a no-op, so a refused send never moves the reader
      // off the anchor.
      scheduleScrollToBottom();

      const accepted = await acceptedPromise;
      if (!accepted) {
        return false;
      }
      // Take the position over for the output this send produces — but only
      // from the attempt that was live at send time. A `?at=` link that arrived
      // while the send was in flight owns the position now: its layout effect
      // already landed its anchor and marked that attempt done, so re-arming
      // follow here would move the viewport to the bottom and abandon it.
      if (!sendTakesOverResume(resumeStateAtSend, resumeStateRef.current)) {
        return true;
      }
      if (resumeStateAtSend) {
        resumeStateAtSend.done = true;
      }
      shouldAutoScrollRef.current = true;
      setChatUI({ shouldAutoScroll: true });
      scheduleScrollToBottom();
      return true;
    },
    [manager, scheduleScrollToBottom, sessionConfig, setChatUI, supportsAttachments]
  );

  const handleSendSlashCommand = useCallback(
    async (command: string, args: string, attachments?: CloudAgentAttachments) => {
      // A command send takes the position over exactly as a message send does,
      // and only once it is accepted: end a resume still looking for its anchor,
      // or the effect re-pauses follow and cancels the scroll for this
      // command's output. A refused command leaves the resume in place.
      const resumeStateAtSend = resumeStateRef.current;
      const acceptedPromise = manager.send({
        payload: { type: 'command', command, arguments: args },
        attachments: supportsAttachments ? attachments : undefined,
      });
      // Pins the tail when the list already follows; a no-op under a resume.
      scheduleScrollToBottom();
      const accepted = await acceptedPromise;
      if (!accepted) {
        return false;
      }
      // As with a message send: the command takes the position over only from
      // the resume that was live when it was sent. A newer `?at=` link owns the
      // position and must not be abandoned at the bottom.
      if (!sendTakesOverResume(resumeStateAtSend, resumeStateRef.current)) {
        return true;
      }
      if (resumeStateAtSend) {
        resumeStateAtSend.done = true;
      }
      shouldAutoScrollRef.current = true;
      setChatUI({ shouldAutoScroll: true });
      scheduleScrollToBottom();
      return true;
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
    const preparedSiblingSessionId =
      selectedWorktreeId && fetchedSessionData?.isInitiated === false
        ? worktreeChats.find(
            chat => chat.sessionId !== sessionIdFromParams && chat.cloudAgentSessionId
          )?.cloudAgentSessionId
        : null;
    const terminalSessionId = sessionIdFromParams
      ? (preparedSiblingSessionId ?? sessionId)
      : worktreeChats.find(chat => chat.cloudAgentSessionId)?.cloudAgentSessionId;
    if (!terminalSessionId) return;

    const terminalId = uuidv4();
    setWorkspaceTabs(state => addTerminalTab(state, terminalId, terminalSessionId));
  }, [
    fetchedSessionData?.isInitiated,
    selectedWorktreeId,
    sessionId,
    sessionIdFromParams,
    worktreeChats,
  ]);

  const handleSelectWorkspaceTab = useCallback((tabId: WorkspaceTabId) => {
    setWorkspaceTabs(state => selectWorkspaceTab(state, tabId));
  }, []);

  const handleWorkspaceValueChange = (value: string) => {
    const chat = openWorktreeChats.find(chat => value === `chat:${chat.sessionId}`);
    if (chat) {
      setWorkspaceTabs(state => selectWorkspaceTab(state, CHAT_TAB_ID));
      if (chat.sessionId !== sessionIdFromParams) openSession(chat.sessionId);
    } else {
      setWorkspaceTabs(state => selectWorkspaceTab(state, value));
    }
  };

  const handleSelectWorktreeFile = useCallback(
    (path: string) => {
      if (!canOpenChanges) return;
      changesDrawerFocusTargetRef.current = 'workspace-tab';
      setWorkspaceTabs(state => openFileTab(state, path));
      setChangesDrawerSessionId(null);
    },
    [canOpenChanges]
  );

  const handleReviewAccepted = useCallback(
    (destinationKiloSessionId: string) => {
      setWorkspaceTabs(state => selectWorkspaceTab(state, CHAT_TAB_ID));
      openSession(destinationKiloSessionId);
    },
    [openSession]
  );
  const review = useWorktreeReview({
    userId: currentUserId,
    organizationId,
    worktreeId: selectedWorktreeId,
    activeKiloSessionId: sessionIdFromParams,
    activeSessionConfig:
      isCurrentSession &&
      activeSessionType === 'cloud-agent' &&
      sessionConfig?.sessionId === sessionId
        ? sessionConfig
        : null,
    enabled: Boolean(
      currentUserId &&
      selectedWorktreeId &&
      (!sessionIdFromParams ||
        (canOpenChanges &&
          activeSessionType === 'cloud-agent' &&
          fetchedSessionData?.worktreeId === selectedWorktreeId &&
          !deletingSessionIds.includes(sessionIdFromParams)))
    ),
    worktreeChats,
    deletingSessionIds,
    api: reviewApi,
    onAccepted: handleReviewAccepted,
  });
  const reviewCommentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!sessionId) return counts;
    for (const comment of review.draft?.comments ?? []) {
      if (comment.anchor.capture.sourceCloudAgentSessionId !== sessionId) continue;
      counts.set(comment.anchor.path, (counts.get(comment.anchor.path) ?? 0) + 1);
    }
    return counts;
  }, [review.draft?.comments, sessionId]);
  const reviewAgainFile = useRef<{
    userId: string;
    organizationId?: string;
    workspaceScope: string;
    kiloSessionId: string;
    cloudAgentSessionId: string;
    path: string;
  } | null>(null);
  const handleOpenReviewComment = (comment: WorktreeReviewComment) => {
    if (!review.scope || review.locked) return;
    const source = review.destinations.find(
      destination =>
        destination.cloudAgentSessionId === comment.anchor.capture.sourceCloudAgentSessionId
    );
    if (!source) return;
    review.setOpen(false);
    if (source.sessionId === sessionIdFromParams && canOpenChanges) {
      setWorkspaceTabs(state =>
        setFileTabMode(openFileTab(state, comment.anchor.path), comment.anchor.path, 'diff')
      );
    } else {
      reviewAgainFile.current = {
        ...review.scope,
        kiloSessionId: source.sessionId,
        cloudAgentSessionId: source.cloudAgentSessionId,
        path: comment.anchor.path,
      };
      openSession(source.sessionId);
    }
  };
  useEffect(() => {
    const file = reviewAgainFile.current;
    if (!file) return;
    if (
      file.userId !== currentUserId ||
      file.organizationId !== organizationId ||
      file.workspaceScope !== workspaceTabScope
    ) {
      reviewAgainFile.current = null;
      return;
    }
    if (
      !canOpenChanges ||
      sessionIdFromParams !== file.kiloSessionId ||
      sessionId !== file.cloudAgentSessionId
    )
      return;
    reviewAgainFile.current = null;
    setWorkspaceTabs(state => setFileTabMode(openFileTab(state, file.path), file.path, 'diff'));
  }, [
    canOpenChanges,
    currentUserId,
    organizationId,
    sessionId,
    sessionIdFromParams,
    workspaceTabScope,
  ]);

  const handleCloseFileTab = useCallback((path: string) => {
    setWorkspaceTabs(state => closeFileTab(state, path));
  }, []);

  const handleCloseChat = useCallback(
    (closingSessionId: string) => {
      if (closingSessionId === sessionIdFromParams) {
        preserveTerminalSelectionRef.current = !chatTabActive;
        const fallbackTerminal = workspaceTabs.terminals.at(-1);
        if (chatTabActive && openWorktreeChats.length === 1 && fallbackTerminal) {
          setWorkspaceTabs(state => selectWorkspaceTab(state, terminalTabId(fallbackTerminal.id)));
        }
      }
      closeSession(closingSessionId);
    },
    [
      chatTabActive,
      closeSession,
      openWorktreeChats.length,
      sessionIdFromParams,
      workspaceTabs.terminals,
    ]
  );

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
        sessionId={tab.cloudAgentSessionId}
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
    preparationDrawerFocusTargetRef.current = null;
    setPreparationDrawerAttemptId(null);
    changesDrawerFocusTargetRef.current = null;
    setChangesDrawerSessionId(null);
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

  const handleOpenPreparationDetails = useCallback((attemptId: string) => {
    const activeElement = document.activeElement;
    preparationDrawerFocusTargetRef.current =
      activeElement instanceof HTMLElement ? activeElement : null;
    childSessionDrawerFocusTargetRef.current = null;
    setChildSessionStack([]);
    changesDrawerFocusTargetRef.current = null;
    setChangesDrawerSessionId(null);
    setPreparationDrawerAttemptId(attemptId);
  }, []);

  const handlePreparationDrawerOpenChange = useCallback((open: boolean) => {
    if (!open) setPreparationDrawerAttemptId(null);
  }, []);

  const handlePreparationDrawerCloseAutoFocus = useCallback((event: Event) => {
    const focusTarget = preparationDrawerFocusTargetRef.current;
    preparationDrawerFocusTargetRef.current = null;
    if (!focusTarget?.isConnected) return;
    event.preventDefault();
    focusTarget.focus();
  }, []);

  const handleToggleChanges = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      changesDrawerFocusTargetRef.current = event.currentTarget;
      childSessionDrawerFocusTargetRef.current = null;
      setChildSessionStack([]);
      preparationDrawerFocusTargetRef.current = null;
      setPreparationDrawerAttemptId(null);
      setChangesDrawerSessionId(current => (current === sessionId ? null : sessionId));
    },
    [sessionId]
  );

  const handleChangesDrawerOpenChange = useCallback((open: boolean) => {
    if (!open) setChangesDrawerSessionId(null);
  }, []);

  const handleChangesDrawerCloseAutoFocus = useCallback((event: Event) => {
    const target = changesDrawerFocusTargetRef.current;
    const focusTarget = target === 'workspace-tab' ? activeWorkspaceTabRef.current : target;
    changesDrawerFocusTargetRef.current = null;
    if (!focusTarget?.isConnected) return;
    event.preventDefault();
    focusTarget.focus();
  }, []);

  // Surface the session's custom agents plus the current visible profile
  // agents to the chat picker. `runtimeAgents` are the agents active when the
  // session was created; the profile list enriches those same agents with
  // their current descriptions, filtered to slugs the session can still run.
  //
  // Only agents that would surface in NewSessionPanel's picker are included
  // (not disabled, not hidden, not subagent-only). Built-in slugs are dropped
  // and the selected slug is appended once when it is neither built-in nor
  // already listed, so an inherited custom slug stays visible.
  const { data: combinedProfilesData } = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: !!organizationId,
  });
  const { data: personalProfiles } = useProfiles({
    organizationId: undefined,
    enabled: !organizationId,
  });
  const effectiveAgentProfileId = organizationId
    ? (combinedProfilesData?.effectiveDefaultId ?? null)
    : (personalProfiles?.find(p => p.isDefault)?.id ?? null);
  const effectiveAgentProfileOrg =
    effectiveAgentProfileId && organizationId
      ? combinedProfilesData?.orgProfiles.some(p => p.id === effectiveAgentProfileId)
        ? organizationId
        : undefined
      : undefined;
  const { data: selectedProfileDetails } = useProfile(effectiveAgentProfileId ?? '', {
    organizationId: effectiveAgentProfileOrg,
    enabled: !!effectiveAgentProfileId,
  });
  // Only surface profile agents the session can still run. `runtimeAgents` is
  // frozen at session creation, but the current visible profile may have
  // gained an agent since; the worker's `validateModeAgainstRuntimeAgents`
  // accepts only built-in slugs or slugs in that frozen list, so a newer
  // profile agent would be offered here and then rejected on send.
  const runtimeAgentSlugs = new Set((sessionConfig?.runtimeAgents ?? []).map(a => a.slug));
  const visibleProfileAgents = (selectedProfileDetails?.agents ?? [])
    .filter(a => !a.config.disable && !a.config.hidden && a.config.mode !== 'subagent')
    .filter(a => runtimeAgentSlugs.has(a.slug));

  const runtimeCustomOptions: CustomModeOption[] = (sessionConfig?.runtimeAgents ?? []).map(a => ({
    value: a.slug,
    label: a.name,
    description: '',
  }));
  const profileCustomOptions: CustomModeOption[] = visibleProfileAgents.map(a => ({
    value: a.slug,
    label: a.name,
    description: a.config.description ?? '',
  }));
  const combinedCustomOptions = ensureSelectedCustomOption(
    dedupeCustomModeOptions([...runtimeCustomOptions, ...profileCustomOptions]),
    sessionConfig?.mode ?? ''
  );
  const customModeOptions: CustomModeOption[] | undefined =
    combinedCustomOptions.length > 0 ? combinedCustomOptions : undefined;

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
  const modelPickerLocked = activeSessionType === 'cloud-agent' && !!agentModelOverride;
  const displayModel = modelPickerLocked ? agentModelOverride : sessionModels.selectedValue;
  const lockTooltip = modelPickerLocked
    ? `Locked by agent "${selectedRuntimeAgent?.name}"`
    : sessionModels.modelPickerDisabled
      ? 'Model changes are unavailable until this CLI model catalog is loaded.'
      : undefined;

  const handleModeChange = useCallback(
    (mode: AgentMode) => {
      if (sessionConfig) setSessionConfig({ ...sessionConfig, mode });
    },
    [sessionConfig, setSessionConfig]
  );

  const handleModelChange = useCallback(
    (model: string) => {
      if (activeSessionType === 'remote') {
        const option = modelOptions.find(candidate => candidate.id === model);
        manager.setRemoteModelOverride(
          createRemoteModelOverride(option, sessionModels.selectedVariant)
        );
        return;
      }
      if (!sessionConfig) return;

      const newModelVariants =
        modelOptions.find(candidate => candidate.id === model)?.variants ?? [];
      const validVariant =
        sessionConfig.variant && newModelVariants.includes(sessionConfig.variant)
          ? sessionConfig.variant
          : newModelVariants[0];
      setSessionConfig({ ...sessionConfig, model, variant: validVariant });
    },
    [
      activeSessionType,
      manager,
      modelOptions,
      sessionConfig,
      sessionModels.selectedVariant,
      setSessionConfig,
    ]
  );

  const handleVariantChange = useCallback(
    (variant: string) => {
      if (activeSessionType === 'remote') {
        const option = modelOptions.find(candidate => candidate.id === sessionModels.selectedValue);
        manager.setRemoteModelOverride(createRemoteModelOverride(option, variant));
        return;
      }
      if (sessionConfig) setSessionConfig({ ...sessionConfig, variant });
    },
    [
      activeSessionType,
      manager,
      modelOptions,
      sessionConfig,
      sessionModels.selectedValue,
      setSessionConfig,
    ]
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
  const showChatInterface =
    Boolean(selectedWorktreeId) || Boolean(sessionConfig) || Boolean(sessionIdFromParams);
  const currentModelOption = modelOptions.find(model =>
    activeSessionType === 'remote'
      ? model.id === sessionModels.selectedValue
      : model.id === sessionConfig?.model
  );
  const modelDisplayName = currentModelOption?.name
    ? formatShortModelDisplayName(currentModelOption.name)
    : undefined;
  const availableVariants =
    activeSessionType === 'remote'
      ? sessionModels.availableVariants
      : (currentModelOption?.variants ?? []);
  // When an agent locks the model, swap the user's session variant for the
  // agent's variant (which may be undefined — i.e. no thinking-effort chip).
  // The variant picker is hidden in that case; it only shows when the user is
  // free to pick their own model.
  const displayVariant = modelPickerLocked ? agentVariantOverride : sessionModels.selectedVariant;
  const displayAvailableVariants = modelPickerLocked ? [] : availableVariants;
  const preparationByMessageId = useMemo(() => {
    const byMessageId = new Map<string, readonly PreparationAttempt[]>();
    for (const attempt of preparationAttempts) {
      if (isNoOpCompletedPreparationAttempt(attempt)) continue;
      const attempts = byMessageId.get(attempt.triggerMessageId) ?? [];
      byMessageId.set(attempt.triggerMessageId, [...attempts, attempt]);
    }
    return byMessageId;
  }, [preparationAttempts]);

  // -- Resume position (`?at=`) ---------------------------------------------
  // One shot per (session, anchor): land the anchor message at the top of the
  // transcript, loading older pages while it still sits before the loaded
  // window. A real user scroll or a send ends the attempt, and so does an
  // anchor the run cannot reach: an id absent from the loaded window after 8
  // pages, no older history to search, a failed older page, or a group that
  // renders no element. Each ends it by opening exactly as an anchor-less link
  // does: at the bottom, following new output. The transcript container starts
  // at `scrollTop = 0`, so leaving the paused resume behind would strand the
  // reader on the oldest loaded message with follow off.
  useLayoutEffect(() => {
    if (!chatTabActive || !sessionIdFromParams || !anchorMessageIdFromParams) return;
    if (isLoading) return;

    const key = `${sessionIdFromParams}\u0000${anchorMessageIdFromParams}`;
    const previous = resumeStateRef.current;
    const state: ResumeState =
      previous && previous.key === key ? previous : { key, attempts: 0, done: false };
    resumeStateRef.current = state;
    if (state.done) return;

    // The resume owns the scroll for this view: pause auto-scroll now, and
    // cancel anything already scheduled, so neither an in-flight frame nor the
    // auto-scroll effect can snap the transcript to the bottom while older
    // pages load toward the anchor.
    shouldAutoScrollRef.current = false;
    setChatUI({ shouldAutoScroll: false });
    cancelScheduledAutoScroll();

    // The snapshot for this session has not painted yet; wait for its commit.
    if (staticMessages.length === 0 && dynamicMessages.length === 0 && !hasOlderMessages) return;

    // Group exactly as the transcript renders (same preparation rows and commit
    // anchors), or the anchor resolves against boundaries the renderer does not
    // have and lands on an earlier rendered group.
    const anchor = resumeAnchorForTranscript(
      [...staticMessages, ...dynamicMessages],
      preparationByMessageId,
      commitsAfterMessage,
      anchorMessageIdFromParams
    );
    const container = scrollContainerRef.current;
    const element = anchor && container ? findAnchorElement(container, anchor.selectorIds) : null;

    const step = planResumeAttempt({
      anchorRendered: element !== null && container !== null,
      anchorResolved: anchor !== null,
      attempts: state.attempts,
      maxOlderPages: MAX_RESUME_OLDER_PAGES,
      hasOlderMessages,
      isLoadingOlderMessages,
      hasOlderMessagesError: olderMessagesError !== null,
    });

    if (step === 'scroll' && element && container) {
      state.done = true;
      isAutoScrollingRef.current = true;
      container.scrollTop = element.offsetTop;
      lastScrollTopRef.current = container.scrollTop;
      const scrollRun = autoScrollRunRef.current + 1;
      autoScrollRunRef.current = scrollRun;
      requestAnimationFrame(() => {
        if (autoScrollRunRef.current === scrollRun) {
          isAutoScrollingRef.current = false;
        }
      });
      return;
    }

    if (step === 'follow-tail') {
      // The anchor cannot be reached — a deleted or trimmed message, an id past
      // the page bound, an older page that failed to load, or a group that
      // renders no element — so no later attempt can reach it. Give up the way
      // an anchor-less link opens: follow the tail again, so the reader lands
      // at the bottom instead of staying paused on the oldest loaded message
      // with follow off (the mobile `?at=` contract).
      shouldAutoScrollRef.current = true;
      setChatUI({ shouldAutoScroll: true });
      scheduleScrollToBottom();
      state.done = true;
      return;
    }

    if (step === 'load-older') {
      state.attempts += 1;
      requestOlderMessages();
    }
  }, [
    anchorMessageIdFromParams,
    cancelScheduledAutoScroll,
    chatTabActive,
    commitsAfterMessage,
    dynamicMessages,
    hasOlderMessages,
    isLoading,
    isLoadingOlderMessages,
    olderMessagesError,
    preparationByMessageId,
    requestOlderMessages,
    scheduleScrollToBottom,
    sessionIdFromParams,
    setChatUI,
    staticMessages,
  ]);
  // A running preparation row already shows live progress inline, so the
  // trailing progress row would repeat the same message beneath it.
  const visibleStatusIndicator =
    (statusIndicator?.type === 'progress' &&
      preparationAttempts.some(attempt => attempt.status === 'running')) ||
    isCommitSummaryRepresented(statusIndicator, commitsAfterMessage)
      ? null
      : statusIndicator;
  const currentChatProgress =
    statusIndicator?.type === 'progress' && isCurrentSession && sessionIdFromParams
      ? { sessionId: sessionIdFromParams, message: statusIndicator.message }
      : null;

  const placeholder = isLoading
    ? 'Loading session…'
    : cloudStatus?.type === 'preparing'
      ? 'Setting up environment…'
      : cloudStatus?.type === 'finalizing'
        ? 'Wrapping up…'
        : 'Ask anything…';

  const canOpenTerminal =
    !sessionIdFromParams && selectedWorktreeId
      ? worktreeChats.some(chat => Boolean(chat.cloudAgentSessionId))
      : Boolean(sessionId) && !isReadOnly;

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
      getSessionCostBreakdown={getCurrentSessionCostBreakdown}
      sessionInfoOpen={sessionInfoOpen}
      onSessionInfoOpenChange={setSessionInfoOpen}
      sessionInfoTriggerRef={sessionInfoTriggerRef}
      soundEnabled={soundEnabled}
      onToggleSound={handleToggleSound}
      changesOpen={changesDrawerOpen}
      onToggleChanges={canOpenChanges ? handleToggleChanges : undefined}
      sessionActive={isStreaming || activity.type === 'busy' || activity.type === 'retrying'}
      canForkToCloud={!isReadOnly && Boolean(fetchedSessionData?.cloudAgentSessionId)}
      sandboxStatusEligible={isSandboxStatusEligible({
        currentUserId,
        sessionId,
        sessionIdFromParams,
        organizationId,
        activeSessionType,
        isReadOnly,
        fetchedSessionData,
      })}
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
          <div className="flex h-full min-w-0 w-full flex-col overflow-hidden">
            <SetPageTitle
              title={
                !sessionIdFromParams && selectedWorktreeId
                  ? 'Worktree'
                  : fetchedSessionData?.title || sessionConfig?.repository || 'Cloud Agent'
              }
            >
              {sessionIdFromParams && isRenderableSessionCost(totalCostUsd) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-11 gap-1 px-2 text-sm font-normal"
                  aria-haspopup="dialog"
                  aria-expanded={sessionInfoOpen}
                  onClick={event => {
                    sessionInfoTriggerRef.current = event.currentTarget;
                    setSessionInfoOpen(true);
                  }}
                >
                  Token Usage{' '}
                  <span className="font-mono tabular-nums">{formatSessionCost(totalCostUsd)}</span>
                </Button>
              )}
            </SetPageTitle>
            {showChatInterface ? (
              <Tabs
                value={activeWorkspaceTabId === CHAT_TAB_ID ? chatTabValue : activeWorkspaceTabId}
                onValueChange={handleWorkspaceValueChange}
                className="flex min-h-0 flex-1 flex-col"
              >
                {showLoadingIndicator && <div className="bg-primary h-0.5 w-full animate-pulse" />}

                <div className="flex shrink-0 flex-wrap items-center gap-x-2 border-b px-3 py-2 sm:flex-nowrap">
                  <MobileSidebarToggle variant="inline" label="Worktrees" />
                  <div className="order-last min-w-0 basis-full sm:order-none sm:flex-1 sm:basis-auto">
                    {(canOpenTerminal || selectedWorktreeId) && (
                      <CloudAgentWorkspaceTabs
                        activeTabId={activeWorkspaceTabId}
                        activeTabRef={activeWorkspaceTabRef}
                        files={filesVisible ? workspaceTabs.files : []}
                        onCloseFile={handleCloseFileTab}
                        chatSessions={worktreeChats}
                        currentChatProgress={currentChatProgress}
                        openChatSessionIds={openWorktreeChats.map(chat => chat.sessionId)}
                        closedChatSessionIds={closedWorktreeChats.map(chat => chat.sessionId)}
                        currentSessionId={sessionIdFromParams}
                        worktreeId={selectedWorktreeId}
                        onSelectChat={openSession}
                        onCloseChat={handleCloseChat}
                        onCreateChat={
                          canCreateWorktreeChat
                            ? () => {
                                void handleCreateWorktreeChat();
                              }
                            : undefined
                        }
                        isCreatingChat={creatingWorktreeSourceSessionId !== null}
                        onRenameChat={renameSession}
                        deletingSessionIds={deletingSessionIds}
                        terminals={workspaceTabs.terminals}
                        terminalStatuses={terminalStatuses}
                        canCreateTerminal={canOpenTerminal}
                        onSelectTab={handleSelectWorkspaceTab}
                        onCreateTerminal={handleCreateTerminalTab}
                        onCloseTerminal={handleCloseTerminalTab}
                      />
                    )}
                  </div>
                  <WorktreeReviewDialog review={review} onOpenComment={handleOpenReviewComment} />
                  {sessionIdFromParams && <div className="ml-auto shrink-0">{sessionActions}</div>}
                </div>

                <div
                  ref={setChildSessionDrawerContainer}
                  className="relative flex min-h-0 flex-1 flex-col"
                >
                  <div
                    inert={
                      childSessionStack.length > 0 ||
                      preparationDrawerAttemptId !== null ||
                      changesDrawerOpen
                    }
                    className="flex min-h-0 flex-1 flex-col"
                  >
                    <TabsContent
                      value={chatTabValue}
                      forceMount
                      hidden={activeWorkspaceTabId !== CHAT_TAB_ID}
                      className={
                        activeWorkspaceTabId === CHAT_TAB_ID
                          ? 'm-0 flex min-h-0 flex-1 flex-col'
                          : 'hidden'
                      }
                    >
                      <div className="relative min-h-0 flex-1">
                        {!sessionIdFromParams &&
                          selectedWorktreeId &&
                          workspaceTabs.activeTabId === CHAT_TAB_ID && (
                            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                              <MessageSquare
                                className="text-muted-foreground h-6 w-6"
                                aria-hidden="true"
                              />
                              <div className="space-y-1">
                                <p className="text-sm font-medium">
                                  {openWorktreeChats.length > 0 ? 'Select a chat' : 'No open chats'}
                                </p>
                                <p className="text-muted-foreground text-sm">
                                  Reopen a saved session from Sessions in the tab options menu
                                  {canCreateWorktreeChat ? ' or start a new chat.' : '.'}
                                </p>
                              </div>
                              {canCreateWorktreeChat && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled={creatingWorktreeSourceSessionId !== null}
                                  onClick={() => void handleCreateWorktreeChat()}
                                >
                                  New chat
                                </Button>
                              )}
                            </div>
                          )}
                        <>
                          <div
                            ref={scrollContainerRef}
                            hidden={!chatTabActive}
                            className={`absolute inset-0 overflow-y-auto px-[max(1rem,calc(50%_-_27rem))] py-2 transition-opacity duration-150 ${showLoadingIndicator ? 'pointer-events-none opacity-40' : 'opacity-100'}`}
                            onScroll={handleScroll}
                          >
                            <div ref={messagesContentRef}>
                              <div className="sr-only" aria-live="polite">
                                {olderArrivalAnnouncement}
                              </div>
                              <OlderMessagesHeader
                                isLoadingOlderMessages={isLoadingOlderMessages}
                                olderMessagesError={olderMessagesError}
                                olderMessagesOmittedItemCount={olderMessagesOmittedItemCount}
                                onRetry={requestOlderMessages}
                              />
                              <ConversationMessages
                                active={chatTabActive}
                                isStreaming={isStreaming}
                                staticMessages={staticMessages}
                                dynamicMessages={dynamicMessages}
                                pendingMessages={pendingMessages}
                                preparationByMessageId={preparationByMessageId}
                                commitsAfterMessage={commitsAfterMessage}
                                getChildMessages={getChildMessages}
                                onOpenChildSession={handleOpenTopLevelChildSession}
                                onOpenPreparationDetails={handleOpenPreparationDetails}
                              />

                              {chatTabActive && (
                                <WorkingIndicator
                                  messages={dynamicMessages}
                                  isStreaming={isStreaming}
                                />
                              )}
                              {!billingFailure &&
                                visibleStatusIndicator &&
                                visibleStatusIndicator.type !== 'error' && (
                                  <SessionStatusIndicator indicator={visibleStatusIndicator} />
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
                      </div>

                      <div hidden={!chatTabActive} className={chatTabActive ? '' : 'hidden'}>
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
                              {billingFailure && (
                                <div className="px-[max(1rem,calc(50%_-_27rem))] pb-2">
                                  <CloudAgentBillingError
                                    failure={billingFailure}
                                    presentation={billingPayerPresentation(billingFailure, {
                                      currentUserId,
                                      organization:
                                        organizationId && organizationName && organizationRole
                                          ? {
                                              id: organizationId,
                                              name: organizationName,
                                              role: organizationRole,
                                            }
                                          : undefined,
                                    })}
                                  />
                                </div>
                              )}
                              <ChatInput
                                onSend={handleSendMessage}
                                onSendCommand={handleSendSlashCommand}
                                onNewChat={
                                  canCreateWorktreeChat ? handleReplaceWorktreeChat : undefined
                                }
                                onStop={handleStopExecution}
                                disabled={!canSend}
                                isStreaming={isStreaming && !activeSuggestion}
                                placeholder={placeholder}
                                slashCommands={availableCommands}
                                mode={modeControlValue(sessionConfig?.mode ?? null)}
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
                                modelPickerDisabled={
                                  modelPickerLocked || sessionModels.modelPickerDisabled
                                }
                                modelPickerTooltip={lockTooltip}
                                variantPickerDisabled={
                                  modelPickerLocked || sessionModels.modelPickerDisabled
                                }
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
                              {!billingFailure && statusIndicator?.type === 'error' && (
                                <div className="px-[max(1rem,calc(50%_-_27rem))] pb-2" role="alert">
                                  <SessionStatusIndicator indicator={statusIndicator} />
                                </div>
                              )}
                              {(sessionConfig?.repository ||
                                (contextUsage !== undefined && contextWindow !== undefined)) && (
                                <div className="text-muted-foreground flex items-center gap-3 px-[max(1rem,calc(50%_-_27rem))] pb-3 text-xs md:pb-4">
                                  {sessionConfig?.repository && (
                                    <div className="flex min-w-0 items-center gap-1.5">
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
                                  {contextUsage !== undefined && contextWindow !== undefined && (
                                    <div className="ml-auto shrink-0">
                                      <ContextUsageIndicator
                                        contextTokens={contextUsage.contextTokens}
                                        contextWindow={contextWindow}
                                      />
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    </TabsContent>
                    <div
                      className={
                        terminalTabActive
                          ? 'h-full min-h-0 px-[max(1rem,calc(50%_-_27rem))] py-2'
                          : 'hidden'
                      }
                    >
                      {terminalPaneMap}
                    </div>
                    {filesVisible &&
                      sessionId &&
                      workspaceTabs.files.map(tab => {
                        const tabId = fileTabId(tab.path);
                        const active = activeWorkspaceTabId === tabId;
                        return (
                          <TabsContent key={tabId} value={tabId} className="m-0 min-h-0 flex-1">
                            {active && (
                              <WorktreeFilePane
                                cloudAgentSessionId={sessionId}
                                organizationId={organizationId}
                                path={tab.path}
                                mode={tab.mode}
                                review={review.scope ? review.bindings : undefined}
                                reviewScope={review.scope ?? undefined}
                                onModeChange={mode =>
                                  setWorkspaceTabs(state => setFileTabMode(state, tab.path, mode))
                                }
                              />
                            )}
                          </TabsContent>
                        );
                      })}
                  </div>
                </div>
              </Tabs>
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
            <PreparationDrawer
              attemptId={preparationDrawerAttemptId}
              onOpenChange={handlePreparationDrawerOpenChange}
              onCloseAutoFocus={handlePreparationDrawerCloseAutoFocus}
              portalContainer={childSessionDrawerContainer}
            />
            {canOpenChanges && sessionId && (
              <WorktreeChangesDrawer
                key={`${organizationId ?? 'personal'}:${sessionId}`}
                cloudAgentSessionId={sessionId}
                organizationId={organizationId}
                open={changesDrawerOpen}
                onOpenChange={handleChangesDrawerOpenChange}
                onCloseAutoFocus={handleChangesDrawerCloseAutoFocus}
                onSelectFile={handleSelectWorktreeFile}
                portalContainer={childSessionDrawerContainer}
                commentCounts={reviewCommentCounts}
              />
            )}
          </div>
        </SuggestionContextProvider>
      </PermissionContextProvider>
    </QuestionContextProvider>
  );
}

export { CloudChatPage };

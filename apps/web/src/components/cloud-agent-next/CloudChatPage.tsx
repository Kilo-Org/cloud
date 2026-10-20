'use client';

import {
  startTransition,
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
import { ArrowDown, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { v4 as uuidv4 } from 'uuid';

import { Skeleton } from '@/components/ui/skeleton';
import type { SessionCommit } from '@kilocode/cloud-agent-sdk';
import { useCloudAgent, useManager } from './CloudAgentProvider';
import { useWorktreeChatCreation, useWorktreeChatTabs } from './CloudSidebarLayout';
import { MobileSidebarToggle } from './MobileSidebarToggle';
import { ChatHeader } from './ChatHeader';
import {
  getWorkspaceControlSession,
  getWorktreeBranch,
  resolveWorkspaceControlSession,
} from './worktree-chat-tabs';
import { isSandboxStatusEligible } from './sandbox-status';
import { resolveSessionBranch } from './session-context-display';
import { ChatInput } from './ChatInput';
import { useSessionComposerFocus } from './useSessionComposerFocus';
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
import { useSessionSwitch } from './use-session-switch';
import { useCachedTranscriptPage } from './use-cached-transcript-page';
import { LocalChatFailure } from './local-sessions/LocalChatFailure';
import { localSessionSourceId } from './local-sessions/local-session';
import { useLocalChatView } from './local-sessions/use-local-chat-view';
import { TranscriptStatusSlot } from './TranscriptStatusSlot';
import { ComposerContextLine } from './ComposerContextLine';
import { CurrentTaskList } from './CurrentTaskList';
import { getCurrentTodos } from './current-todos';
import { planResumeAttempt, resumeAnchorForTranscript, sendTakesOverResume } from './resume-anchor';
import { ChildSessionDrawer } from './ChildSessionDrawer';
import type { ChildSessionDrawerEntry } from './ChildSessionSection';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { isNoOpCompletedPreparationAttempt } from './preparation-summary';
import { PreparationDrawer } from './PreparationDrawer';
import { QuestionToolCard } from './QuestionToolCard';
import { QuestionContextProvider } from './QuestionContext';
import { PermissionCard, PermissionContextProvider } from './PermissionCard';
import { SuggestionContextProvider } from './SuggestionCard';
import { SessionContinuationPanel } from './SessionContinuationPanel';
import { CloudAgentTerminalPane } from './CloudAgentTerminalDock';
import { CloudAgentBillingError } from './CloudAgentBillingError';
import { OlderMessagesHeader } from './OlderMessagesHeader';
import { resolveTranscriptPhase, transcriptReadyForEffects } from './transcript-switch';
import {
  OLDER_MESSAGES_NEAR_BOTTOM_PX,
  shouldAnnounceOlderMessagesArrival,
  useOlderMessagesPagination,
} from './older-messages-scroll';
import { billingPayerPresentation } from './billing-payer-presentation';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { CloudAgentWorkspaceTabs } from './CloudAgentWorkspaceTabs';
import { PreviewPortDialog } from './PreviewPortDialog';
import { WorktreeChangesView } from './WorktreeChanges';
import { WorktreeFilePane } from './WorktreeFilePane';
import { commitsByMessageAnchor, isCommitSummaryRepresented } from './message-presentation';
import { WorktreeReviewDialog } from './WorktreeReviewDialog';
import { useWorktreeReview } from './useWorktreeReview';
import { selectTerminalOwner } from './terminal-owner';
import type { WorktreeReviewComment } from './worktree-review';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { canOpenWorktreeChanges } from './worktree-changes';
import {
  CHAT_TAB_ID,
  addTerminalTab,
  closeFileTab,
  closeTerminalTab,
  fileTabId,
  getWorkspaceTabScope,
  openFileTab,
  selectWorkspaceTab,
  setFileTabMode,
  terminalIdFromTabId,
  terminalTabId,
} from './workspace-tabs';
import { getWorkspaceTabsStorageKey } from './workspace-tabs-storage';
import { usePersistedWorkspaceTabs } from './hooks/usePersistedWorkspaceTabs';
import { PreviewLinksContext } from './use-preview';
import { usePreviewController } from './use-preview-controller';
import {
  createRemoteModelOverride,
  useSessionModels,
  validateRemoteModelOverride,
} from './hooks/useSessionModels';
import { resolveContextWindow } from './model-context-lengths';
import type { KnownModel } from './known-models';
import { useSlashCommandSets } from '@/hooks/useSlashCommandSets';
import { useCelebrationSound } from '@/hooks/useCelebrationSound';
import { useCliSessionPresence } from '@/hooks/useCliSessionPresence';
import type { CloudAgentAttachments } from '@/lib/cloud-agent/constants';

import { cn } from '@/lib/utils';
import { getChatDisplayTitle } from './utils/session-title';
import { SetPageTitle } from '@/components/SetPageTitle';
import { formatShortModelDisplayName } from '@/lib/format-model-name';
import type { AgentMode, StoredMessage } from './types';
import type { PreparationAttempt } from '@kilocode/cloud-agent-sdk';
import type { WorkspaceTabId } from './workspace-tabs';
import type { TerminalStatus } from './useCloudAgentTerminal';

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
  knownModels?: readonly KnownModel[];
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

const NO_KNOWN_MODELS: readonly KnownModel[] = [];

export default function CloudChatPage({
  currentUserId,
  organizationId,
  organizationName,
  organizationRole,
  knownModels = NO_KNOWN_MODELS,
}: CloudChatPageProps) {
  const manager = useManager();
  const reviewApi = useCloudAgent();
  const { createWorktreeChat } = useWorktreeChatCreation();
  const {
    selectedWorktreeId,
    worktreeChats,
    openWorktreeChats,
    closedWorktreeChats,
    openSession,
    composerFocusRequest,
    closeSession,
    renameSession,
    deletingSessionIds,
    retryLocalChat,
    discardLocalChat,
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
  const [changesViewScope, setChangesViewScope] = useState<string | null>(null);
  const changesViewFocusTargetRef = useRef<HTMLElement | null>(null);
  const changesViewOpenedTabRef = useRef<WorkspaceTabId | null>(null);
  const activeWorkspaceTabRef = useRef<HTMLButtonElement | null>(null);
  const closeChangesView = useCallback(() => {
    changesViewOpenedTabRef.current = null;
    changesViewFocusTargetRef.current = null;
    setChangesViewScope(null);
  }, []);

  const sessionIdFromParams = searchParams?.get('sessionId') ?? null;
  const anchorMessageIdFromParams = searchParams?.get('at') ?? null;
  const { localSession, lastStartedSessionId } = useSessionSwitch(manager, sessionIdFromParams);
  // A known Cloud Agent chat (seeded by the server, or seen recently) skips the loading state.
  const cachedPage = useCachedTranscriptPage(organizationId ?? null, sessionIdFromParams);
  useEffect(() => {
    childSessionDrawerFocusTargetRef.current = null;
    setChildSessionStack([]);
    preparationDrawerFocusTargetRef.current = null;
    setPreparationDrawerAttemptId(null);
    closeChangesView();
  }, [sessionIdFromParams, closeChangesView]);

  const isStreaming = useAtomValue(manager.atoms.isStreaming);
  const isLoading = useAtomValue(manager.atoms.isLoading);
  const isRefreshingCachedTranscript = useAtomValue(manager.atoms.isRefreshingCachedTranscript);
  const cachedTranscriptSessionId = useAtomValue(manager.atoms.cachedTranscriptSessionId);
  const isReplayingLiveHistory = useAtomValue(manager.atoms.isReplayingLiveHistory);
  const isReadOnly = useAtomValue(manager.atoms.isReadOnly);
  const supportsAttachments = useAtomValue(manager.atoms.supportsAttachments);
  const canSend = useAtomValue(manager.atoms.canSend);
  const canInterrupt = useAtomValue(manager.atoms.canInterrupt);
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
  const sendingMessageIds = useAtomValue(manager.atoms.sendingMessageIds);
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
  // Sidebar data can name a chat before its session loads; an unknown title
  // stays empty rather than flashing a placeholder name.
  const storedChat = worktreeChats.find(chat => chat.sessionId === sessionIdFromParams);
  const displayedChatTitle =
    isCurrentSession && fetchedSessionData
      ? getChatDisplayTitle(fetchedSessionData.title)
      : storedChat?.prompt;
  const totalCostUsd = isCurrentSession
    ? getSessionTotalCostUsd(fetchedSessionData?.totalCostMicrodollars, liveTotalCostUsd)
    : 0;
  const transcriptMessageCount = staticMessages.length + dynamicMessages.length;
  const terminalOpenFailure = statusIndicator?.type === 'error';
  const transcriptPhase = resolveTranscriptPhase({
    requestedSessionId: sessionIdFromParams,
    lastStartedSessionId,
    ownerSessionId: fetchedSessionData?.kiloSessionId ?? null,
    cachedSessionId: cachedTranscriptSessionId,
    isLoading,
    hasMessages: transcriptMessageCount > 0,
    terminalOpenFailure,
    localMessageCount: localSession ? (localSession.firstMessage ? 1 : 0) : null,
    isReplayingLiveHistory,
    hasKnownSettings: Boolean(cachedPage?.sessionConfig),
  });
  const transcriptVisible = transcriptReadyForEffects(transcriptPhase);
  const transcriptReady = transcriptVisible && !isRefreshingCachedTranscript;

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

  const sessionBranch = resolveSessionBranch({
    scope: {
      displayedKiloSessionId: sessionIdFromParams,
      displayedWorktreeId: selectedWorktreeId,
    },
    metadata: fetchedSessionData
      ? {
          kiloSessionId: fetchedSessionData.kiloSessionId,
          worktreeId: fetchedSessionData.worktreeId ?? null,
          branch: fetchedSessionData.gitBranch,
        }
      : null,
  });

  // The composer's repository line reserves its row and shows the sidebar's copy
  // until the session loads, so the composer does not move when it resolves.
  const composerRepository = sessionConfig?.repository || storedChat?.repository;
  const composerBranch =
    sessionBranch ??
    storedChat?.branch ??
    getWorktreeBranch(selectedWorktreeId, worktreeChats) ??
    undefined;

  const setSessionConfig = useSetAtom(manager.atoms.sessionConfig);
  // A local chat shows the settings it copied from its source until its own load.
  const composerSettings =
    sessionConfig ?? localSession?.composer ?? cachedPage?.sessionConfig ?? null;

  const [attachmentMessageUuid] = useState(() => uuidv4());
  const [terminalStatuses, setTerminalStatuses] = useState<
    Record<string, TerminalStatusSummary | undefined>
  >({});
  const preserveTerminalSelectionRef = useRef(false);
  const previousSessionIdRef = useRef<string | null>(sessionIdFromParams);
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
  const [workspaceTabs, setWorkspaceTabs] = usePersistedWorkspaceTabs(
    getWorkspaceTabsStorageKey(
      resolvedWorkspaceScope.currentUserId,
      resolvedWorkspaceScope.organizationId
    ),
    resolvedWorkspaceScope.scope
  );
  const workspaceControlSession = resolveWorkspaceControlSession({
    requestedSessionId: sessionIdFromParams,
    requestedSessionLoaded: isCurrentSession,
    local: localSession ? { sourceSessionId: localSessionSourceId(localSession) } : null,
    worktreeId: selectedWorktreeId,
    chats: worktreeChats,
    deletingSessionIds,
  });
  const workspaceCloudSessionId = workspaceControlSession?.cloudAgentSessionId ?? sessionId;
  const currentSessionCanOpenChanges =
    sessionIdFromParams !== null &&
    isCurrentSession &&
    canOpenWorktreeChanges(sessionId, isReadOnly) &&
    fetchedSessionData?.organizationId === (organizationId ?? null);
  const changesControlSession = getWorkspaceControlSession(
    selectedWorktreeId,
    worktreeChats,
    deletingSessionIds
  );
  const changesCloudSessionId = currentSessionCanOpenChanges
    ? sessionId
    : changesControlSession?.cloudAgentSessionId;
  const canOpenChanges =
    Boolean(currentUserId) && canOpenWorktreeChanges(changesCloudSessionId, isReadOnly);
  const fileScope = JSON.stringify([currentUserId, organizationId, workspaceTabScope]);
  const changesViewOpen = canOpenChanges && changesViewScope === fileScope;
  const [resolvedFileScope, setResolvedFileScope] = useState(fileScope);
  const filesVisible = canOpenChanges && resolvedFileScope === fileScope;
  // Commits come from the loaded chat, so they follow its own access, not the workspace's.
  const commitsVisible = filesVisible && currentSessionCanOpenChanges;
  const [commitsCache, setCommitsCache] = useState<{
    infos: StoredMessage['info'][];
    commits: readonly SessionCommit[];
    commitsVisible: boolean;
    value: ReadonlyMap<string, readonly SessionCommit[]>;
  } | null>(null);
  const messageInfosForCommits = [...staticMessages, ...dynamicMessages].map(
    message => message.info
  );
  let commitsAfterMessage: ReadonlyMap<string, readonly SessionCommit[]>;
  if (
    commitsCache !== null &&
    commitsCache.commitsVisible === commitsVisible &&
    commitsCache.commits === commits &&
    commitsCache.infos.length === messageInfosForCommits.length &&
    commitsCache.infos.every((info, index) => info === messageInfosForCommits[index])
  ) {
    commitsAfterMessage = commitsCache.value;
  } else {
    commitsAfterMessage = commitsByMessageAnchor(
      [...staticMessages, ...dynamicMessages],
      commitsVisible ? commits : []
    );
    setCommitsCache({
      infos: messageInfosForCommits,
      commits,
      commitsVisible,
      value: commitsAfterMessage,
    });
  }
  const currentTodos = useMemo(
    () => (isCurrentSession ? getCurrentTodos([...staticMessages, ...dynamicMessages]) : null),
    [dynamicMessages, isCurrentSession, staticMessages]
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
    setTerminalStatuses({});
  }

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    previousSessionIdRef.current = sessionIdFromParams;
    if (previousSessionId === sessionIdFromParams) return;
    if (preserveTerminalSelectionRef.current) {
      preserveTerminalSelectionRef.current = false;
      return;
    }
    if (sessionIdFromParams) {
      setWorkspaceTabs(state => selectWorkspaceTab(state, CHAT_TAB_ID));
    }
  }, [sessionIdFromParams, setWorkspaceTabs]);

  useEffect(() => {
    closeChangesView();
  }, [fileScope, canOpenChanges, closeChangesView]);

  useEffect(() => {
    const openedTab = changesViewOpenedTabRef.current;
    if (!changesViewOpen || openedTab === null || activeWorkspaceTabId === openedTab) return;
    closeChangesView();
  }, [activeWorkspaceTabId, changesViewOpen, closeChangesView]);

  const previousChangesViewOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = previousChangesViewOpenRef.current;
    previousChangesViewOpenRef.current = changesViewOpen;
    if (!wasOpen || changesViewOpen) return;
    const target = changesViewFocusTargetRef.current;
    changesViewFocusTargetRef.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [changesViewOpen]);

  const sessionModels = useSessionModels({
    activeSessionType,
    remoteModelState,
    observedModel,
    remoteModelOverride,
    gatewayModelId: composerSettings?.model,
    gatewayVariant: composerSettings?.variant,
    // A chat listed under this route belongs to its organization, so its models load at once.
    fetchedSessionData:
      fetchedSessionData ??
      localSession ??
      (storedChat ? { organizationId: organizationId ?? null } : null),
    routeOrganizationId: organizationId,
    sessionIdFromParams,
    knownModels,
    currentUserId,
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

  const { play: playCelebrationSound, soundEnabled, setSoundEnabled } = useCelebrationSound();

  const prevActivityRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevActivityRef.current === 'busy' && activity.type === 'idle') {
      playCelebrationSound();
      void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
    }
    prevActivityRef.current = activity.type;
  }, [activity.type, playCelebrationSound, queryClient, trpc]);

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
  const transcriptPositionedRef = useRef(false);
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
    ready: transcriptReady,
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

    setShowScrollButton(false);
    // Already pinned: no scroll event will follow, so do not mark the next
    // frame's scroll as programmatic or a reader's scroll in it is ignored.
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) {
      lastScrollTopRef.current = el.scrollTop;
      return;
    }
    const scrollRun = autoScrollRunRef.current + 1;
    autoScrollRunRef.current = scrollRun;
    isAutoScrollingRef.current = true;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;

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

  useLayoutEffect(() => {
    // An in-progress resume has already paused auto-scroll and owns the
    // position; do not let an atom write (e.g. a session reset) re-enable it.
    const resumeState = resumeStateRef.current;
    if (resumeState && !resumeState.done) return;
    shouldAutoScrollRef.current = chatUI.shouldAutoScroll;
  }, [chatUI.shouldAutoScroll]);

  useLayoutEffect(() => {
    cancelScheduledAutoScroll();
    autoScrollRunRef.current += 1;
    isAutoScrollingRef.current = false;
    transcriptPositionedRef.current = false;
    resumeStateRef.current =
      sessionIdFromParams && anchorMessageIdFromParams
        ? {
            key: `${sessionIdFromParams}\u0000${anchorMessageIdFromParams}`,
            attempts: 0,
            done: false,
          }
        : null;
    shouldAutoScrollRef.current = !resumeStateRef.current;
    setChatUI({ shouldAutoScroll: shouldAutoScrollRef.current });
    lastScrollTopRef.current = 0;
    wasNearBottomRef.current = true;
    olderArrivalInitializedRef.current = false;
    olderArrivalCountRef.current = 0;
    olderArrivalNewestKeyRef.current = null;
    setOlderArrivalAnnouncement('');
    setShowScrollButton(false);
  }, [anchorMessageIdFromParams, cancelScheduledAutoScroll, sessionIdFromParams, setChatUI]);

  useLayoutEffect(() => {
    if (!chatTabActive || !transcriptVisible) {
      cancelScheduledAutoScroll();
      transcriptPositionedRef.current = false;
    }
  }, [cancelScheduledAutoScroll, chatTabActive, transcriptVisible]);

  useLayoutEffect(() => {
    if (!transcriptVisible || !chatTabActive || transcriptMessageCount === 0) return;
    if (transcriptPositionedRef.current) return;
    transcriptPositionedRef.current = true;
    scrollToBottomNow();
  }, [
    anchorMessageIdFromParams,
    chatTabActive,
    scrollToBottomNow,
    sessionIdFromParams,
    transcriptMessageCount,
    transcriptVisible,
  ]);

  useLayoutEffect(() => {
    if (!transcriptVisible || !chatTabActive || !chatUI.shouldAutoScroll) return;
    scrollToBottomNow();
  }, [
    staticMessages,
    dynamicMessages,
    chatTabActive,
    chatUI.shouldAutoScroll,
    scrollToBottomNow,
    transcriptVisible,
  ]);

  useEffect(() => {
    if (!transcriptVisible || !chatTabActive || !chatUI.shouldAutoScroll) return;
    if (typeof ResizeObserver === 'undefined') return;

    const content = messagesContentRef.current;
    if (!content) return;

    // Resize callbacks run after layout and before paint, so pinning here keeps
    // growth that bypasses the message effect (status rows, late layout) from
    // showing for a frame; the scheduled pass still catches later layout.
    const observer = new ResizeObserver(() => {
      scrollToBottomNow();
      scheduleScrollToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [
    chatTabActive,
    chatUI.shouldAutoScroll,
    scheduleScrollToBottom,
    scrollToBottomNow,
    transcriptVisible,
  ]);

  const newestTranscriptMessageId =
    dynamicMessages.at(-1)?.info.id ?? staticMessages.at(-1)?.info.id ?? null;

  useEffect(() => {
    if (!transcriptReady) return;
    if (
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: olderArrivalInitializedRef.current,
        previousCount: olderArrivalCountRef.current,
        nextCount: transcriptMessageCount,
        previousNewestKey: olderArrivalNewestKeyRef.current,
        nextNewestKey: newestTranscriptMessageId,
      })
    ) {
      setOlderArrivalAnnouncement('Earlier messages loaded');
    }
    olderArrivalInitializedRef.current = true;
    olderArrivalCountRef.current = transcriptMessageCount;
    olderArrivalNewestKeyRef.current = newestTranscriptMessageId;
  }, [newestTranscriptMessageId, transcriptMessageCount, transcriptReady]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (!transcriptVisible) {
      lastScrollTopRef.current = el.scrollTop;
      return;
    }
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

    if (scrolledUp || distanceFromBottom >= OLDER_MESSAGES_NEAR_BOTTOM_PX) {
      shouldAutoScrollRef.current = false;
      setChatUI({ shouldAutoScroll: false });
      cancelScheduledAutoScroll();
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
  }, [cancelScheduledAutoScroll, manager, setChatUI, transcriptVisible, tryLoadOlderFromScroll]);

  const scrollToBottom = useCallback(() => {
    shouldAutoScrollRef.current = true;
    setChatUI({ shouldAutoScroll: true });
    scheduleScrollToBottom();
  }, [scheduleScrollToBottom, setChatUI]);

  const worktreeChatSourceSessionId =
    sessionIdFromParams && !localSession
      ? activeSessionType === 'cloud-agent' &&
        fetchedSessionData?.worktreeId &&
        fetchedSessionData.kiloSessionId === sessionIdFromParams
        ? sessionIdFromParams
        : null
      : (worktreeChats.find(chat => !chat.localSync)?.sessionId ?? null);
  const canCreateWorktreeChat = worktreeChatSourceSessionId !== null;
  const newChatComposer = composerSettings
    ? {
        mode: composerSettings.mode,
        model: composerSettings.model,
        variant: composerSettings.variant ?? null,
      }
    : null;
  const handleCreateWorktreeChat = useCallback(() => {
    if (!worktreeChatSourceSessionId) return;
    setWorkspaceTabs(state => selectWorkspaceTab(state, CHAT_TAB_ID));
    createWorktreeChat(worktreeChatSourceSessionId, { composer: newChatComposer });
  }, [createWorktreeChat, newChatComposer, worktreeChatSourceSessionId]);
  const handleReplaceWorktreeChat = useCallback(() => {
    if (!canCreateWorktreeChat || !sessionIdFromParams) return false;
    return createWorktreeChat(sessionIdFromParams, {
      placement: 'replace',
      composer: newChatComposer,
    });
  }, [canCreateWorktreeChat, createWorktreeChat, newChatComposer, sessionIdFromParams]);

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

  const fetchRouteReady = useCallback(
    async (kiloSessionId: string): Promise<boolean | undefined> => {
      try {
        const data = await queryClient.fetchQuery({
          ...trpc.cliSessionsV2.getWithRuntimeState.queryOptions({ session_id: kiloSessionId }),
          staleTime: 0,
          retry: false,
          networkMode: 'always',
        });
        return data.runtimeState?.routeReady;
      } catch {
        return undefined;
      }
    },
    [queryClient, trpc]
  );

  const resolveTerminalOwner = useCallback(async (): Promise<string | null> => {
    const loadedIsCurrent =
      sessionIdFromParams !== null && fetchedSessionData?.kiloSessionId === sessionIdFromParams;
    const loadedRouteReady = loadedIsCurrent ? fetchedSessionData?.routeReady : undefined;

    const candidates = worktreeChats.flatMap(chat =>
      chat.cloudAgentSessionId
        ? [
            {
              kiloSessionId: chat.sessionId,
              cloudAgentSessionId: chat.cloudAgentSessionId,
              routeReady: chat.sessionId === sessionIdFromParams ? loadedRouteReady : undefined,
            },
          ]
        : []
    );
    if (candidates.length === 0) return null;

    // Only the viewed session's route is known without a read; resolve the
    // siblings' routes before choosing so a stopped sibling is never picked
    // ahead of a ready one.
    if (candidates.some(candidate => candidate.routeReady === undefined)) {
      await Promise.all(
        candidates.map(async candidate => {
          if (candidate.routeReady === undefined) {
            candidate.routeReady = await fetchRouteReady(candidate.kiloSessionId);
          }
        })
      );
    }

    return selectTerminalOwner({
      loadedKiloSessionId: sessionIdFromParams,
      candidates,
    });
  }, [
    fetchRouteReady,
    fetchedSessionData?.kiloSessionId,
    fetchedSessionData?.routeReady,
    sessionIdFromParams,
    worktreeChats,
  ]);

  const openTerminalTabForSession = useCallback(
    (cloudAgentSessionId: string) => {
      const terminalId = uuidv4();
      setWorkspaceTabs(state => addTerminalTab(state, terminalId, cloudAgentSessionId));
    },
    [setWorkspaceTabs]
  );

  const handleCreateTerminalTab = useCallback(() => {
    // Standalone sessions own their own route; the server reports readiness.
    if (!selectedWorktreeId) {
      if (sessionId) openTerminalTabForSession(sessionId);
      return;
    }

    const loadedIsCurrent =
      sessionIdFromParams !== null && fetchedSessionData?.kiloSessionId === sessionIdFromParams;
    const loadedRouteReady = loadedIsCurrent ? fetchedSessionData?.routeReady : undefined;

    // Any session with a ready route can own the worktree terminal. Prefer the
    // viewed session while its route is not known to be unready; otherwise
    // resolve the sibling whose route is ready.
    if (sessionId && loadedRouteReady !== false) {
      openTerminalTabForSession(sessionId);
      return;
    }

    void resolveTerminalOwner().then(owner => {
      if (owner) openTerminalTabForSession(owner);
    });
  }, [
    fetchedSessionData?.kiloSessionId,
    fetchedSessionData?.routeReady,
    openTerminalTabForSession,
    resolveTerminalOwner,
    selectedWorktreeId,
    sessionId,
    sessionIdFromParams,
  ]);

  const handleSelectWorkspaceTab = useCallback(
    (tabId: WorkspaceTabId) => setWorkspaceTabs(state => selectWorkspaceTab(state, tabId)),
    [setWorkspaceTabs]
  );

  const handleWorkspaceValueChange = (value: string) => {
    startTransition(() => {
      const chat = openWorktreeChats.find(chat => value === `chat:${chat.sessionId}`);
      if (chat) {
        setWorkspaceTabs(state => selectWorkspaceTab(state, CHAT_TAB_ID));
        if (chat.sessionId !== sessionIdFromParams) openSession(chat.sessionId);
      } else {
        setWorkspaceTabs(state => selectWorkspaceTab(state, value));
      }
    });
  };

  const handleReviewAccepted = useCallback(
    (destinationKiloSessionId: string) => {
      closeChangesView();
      setWorkspaceTabs(state => selectWorkspaceTab(state, CHAT_TAB_ID));
      openSession(destinationKiloSessionId);
    },
    [closeChangesView, openSession, setWorkspaceTabs]
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
    if (!workspaceCloudSessionId) return counts;
    for (const comment of review.draft?.comments ?? []) {
      if (comment.anchor.capture.sourceCloudAgentSessionId !== workspaceCloudSessionId) continue;
      counts.set(comment.anchor.path, (counts.get(comment.anchor.path) ?? 0) + 1);
    }
    return counts;
  }, [review.draft?.comments, workspaceCloudSessionId]);
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
      closeChangesView();
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
    setWorkspaceTabs,
    workspaceTabScope,
  ]);

  const handleCloseFileTab = useCallback(
    (path: string) => {
      setWorkspaceTabs(state => closeFileTab(state, path));
    },
    [setWorkspaceTabs]
  );

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
      setWorkspaceTabs,
      workspaceTabs.terminals,
    ]
  );

  const handleCloseTerminalTab = useCallback(
    (terminalId: string) => {
      setWorkspaceTabs(state => closeTerminalTab(state, terminalId));
      setTerminalStatuses(current => {
        const next = { ...current };
        delete next[terminalId];
        return next;
      });
    },
    [setWorkspaceTabs]
  );

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

  const handleOpenTopLevelChildSession = useCallback(
    (entry: ChildSessionDrawerEntry) => {
      const activeElement = document.activeElement;
      childSessionDrawerFocusTargetRef.current =
        activeElement instanceof HTMLElement ? activeElement : null;
      preparationDrawerFocusTargetRef.current = null;
      setPreparationDrawerAttemptId(null);
      closeChangesView();
      setChildSessionStack([entry]);
    },
    [closeChangesView]
  );

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

  const handleOpenPreparationDetails = useCallback(
    (attemptId: string) => {
      const activeElement = document.activeElement;
      preparationDrawerFocusTargetRef.current =
        activeElement instanceof HTMLElement ? activeElement : null;
      childSessionDrawerFocusTargetRef.current = null;
      setChildSessionStack([]);
      closeChangesView();
      setPreparationDrawerAttemptId(attemptId);
    },
    [closeChangesView]
  );

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
      changesViewFocusTargetRef.current = event.currentTarget;
      childSessionDrawerFocusTargetRef.current = null;
      setChildSessionStack([]);
      preparationDrawerFocusTargetRef.current = null;
      setPreparationDrawerAttemptId(null);
      if (changesViewOpen) {
        changesViewOpenedTabRef.current = null;
        setChangesViewScope(null);
      } else {
        changesViewOpenedTabRef.current = activeWorkspaceTabId;
        setChangesViewScope(fileScope);
      }
    },
    [activeWorkspaceTabId, changesViewOpen, fileScope]
  );

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

  // Delay the loading indicator to avoid flashing for fast switches.
  const isTranscriptLoading =
    transcriptPhase === 'opening' || isRefreshingCachedTranscript || isLoading;
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  useEffect(() => {
    setShowLoadingIndicator(false);
    if (!isTranscriptLoading) return;
    const timer = setTimeout(() => setShowLoadingIndicator(true), 1000);
    return () => clearTimeout(timer);
  }, [isTranscriptLoading, sessionIdFromParams]);
  const currentChatLoadingLabel =
    isTranscriptLoading && showLoadingIndicator
      ? isRefreshingCachedTranscript
        ? 'Refreshing session…'
        : 'Loading session…'
      : null;

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
    if (!transcriptVisible) return;
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
    if (!element && !transcriptReady) return;

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
    transcriptReady,
    transcriptVisible,
  ]);
  // A running preparation row already shows live progress inline, so the
  // trailing progress row would repeat the same message beneath it.
  const preparationRowShowsProgress = preparationAttempts.some(
    attempt => attempt.status === 'running'
  );
  const visibleStatusIndicator =
    (statusIndicator?.type === 'progress' && preparationRowShowsProgress) ||
    isCommitSummaryRepresented(statusIndicator, commitsAfterMessage)
      ? null
      : statusIndicator;
  // A chat created here shows what is known locally until its live transcript loads.
  const {
    failure: localFailure,
    transcript: shownTranscript,
    statusIndicator: slotStatusIndicator,
    billingFailure: shownBillingFailure,
  } = useLocalChatView({
    localSession,
    transcriptPhase,
    live: {
      staticMessages,
      dynamicMessages,
      pendingMessages,
      sendingMessageIds,
      statusIndicator: visibleStatusIndicator,
      billingFailure,
    },
  });
  const currentChatProgress =
    statusIndicator?.type === 'progress' && isCurrentSession && sessionIdFromParams
      ? { sessionId: sessionIdFromParams, message: statusIndicator.message }
      : null;

  const chatOpening = transcriptPhase === 'opening' || (isLoading && transcriptPhase !== 'local');

  // The worktree's sandbox stays reachable through its control chat while a chat loads.
  const canOpenTerminal =
    !sessionIdFromParams && selectedWorktreeId
      ? worktreeChats.some(chat => Boolean(chat.cloudAgentSessionId))
      : workspaceControlSession
        ? Boolean(workspaceControlSession.cloudAgentSessionId)
        : Boolean(sessionId) && !isReadOnly;

  const preview = usePreviewController({
    selectedWorktreeId,
    routeReady:
      sessionIdFromParams !== null && fetchedSessionData?.kiloSessionId === sessionIdFromParams
        ? fetchedSessionData?.routeReady
        : undefined,
    sessionIdFromParams,
    sessionId: workspaceCloudSessionId,
    worktreeChats,
    canOpenTerminal,
    organizationId,
  });

  // A chat takes typing at once, also while it is created or opens; sending waits for it.
  const composerTextareaDisabled =
    transcriptPhase === 'local' || chatOpening
      ? false
      : activeSessionType === 'cloud-agent'
        ? isReadOnly
        : !canSend;
  const composerInputRef = useSessionComposerFocus(
    composerFocusRequest,
    sessionIdFromParams,
    isCurrentSession && !isLoading && transcriptPhase !== 'opening',
    isReadOnly || Boolean(activeQuestion || activePermission) || !chatTabActive || changesViewOpen,
    composerTextareaDisabled
  );

  // Feedback context carries the session the server resolved for this route.
  const sessionActions = (
    <ChatHeader
      cloudAgentSessionId={workspaceCloudSessionId ?? 'Starting session…'}
      changesCloudAgentSessionId={changesCloudSessionId ?? undefined}
      worktreeId={selectedWorktreeId ?? undefined}
      sandboxScopeId={selectedWorktreeId ?? workspaceCloudSessionId ?? 'Starting session…'}
      kiloSessionId={
        sessionIdFromParams
          ? fetchedSessionData?.kiloSessionId === sessionIdFromParams
            ? sessionIdFromParams
            : undefined
          : workspaceControlSession?.sessionId
      }
      organizationId={organizationId}
      repository={workspaceControlSession?.repository ?? sessionConfig?.repository ?? ''}
      branch={
        workspaceControlSession
          ? (workspaceControlSession.branch ?? undefined)
          : fetchedSessionData?.isPreparingAsync &&
              cloudStatus?.type !== 'ready' &&
              !preparationAttempts.some(attempt => attempt.status === 'completed')
            ? undefined
            : (sessionBranch ?? undefined)
      }
      gitUrl={workspaceControlSession ? undefined : fetchedSessionData?.gitUrl}
      model={workspaceControlSession?.model ?? sessionConfig?.model}
      modelDisplayName={workspaceControlSession ? undefined : modelDisplayName}
      getSessionCostBreakdown={workspaceControlSession ? undefined : getCurrentSessionCostBreakdown}
      sessionInfoOpen={sessionInfoOpen}
      onSessionInfoOpenChange={setSessionInfoOpen}
      sessionInfoTriggerRef={sessionInfoTriggerRef}
      soundEnabled={soundEnabled}
      onToggleSound={handleToggleSound}
      changesOpen={changesViewOpen}
      onToggleChanges={canOpenChanges ? handleToggleChanges : undefined}
      sessionActive={
        !workspaceControlSession &&
        (isStreaming || activity.type === 'busy' || activity.type === 'retrying')
      }
      canForkToCloud={
        Boolean(workspaceControlSession) ||
        (!isReadOnly && Boolean(fetchedSessionData?.cloudAgentSessionId))
      }
      sandboxStatusEligible={isSandboxStatusEligible({
        currentUserId,
        sessionId: workspaceCloudSessionId,
        sessionIdFromParams: workspaceControlSession?.sessionId ?? sessionIdFromParams,
        organizationId,
        activeSessionType: workspaceControlSession ? 'cloud-agent' : activeSessionType,
        isReadOnly: workspaceControlSession ? false : isReadOnly,
        fetchedSessionData: workspaceControlSession
          ? {
              kiloSessionId: workspaceControlSession.sessionId,
              cloudAgentSessionId: workspaceCloudSessionId,
              organizationId: organizationId ?? null,
            }
          : fetchedSessionData,
      })}
    />
  );

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
                  : sessionIdFromParams
                    ? (displayedChatTitle ?? '')
                    : 'Cloud Agent'
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
                <div className="flex shrink-0 flex-wrap items-center gap-x-2 border-b px-3 py-2 sm:flex-nowrap">
                  <MobileSidebarToggle variant="inline" label="Worktrees" />
                  <div
                    className={cn(
                      'order-last min-w-0 basis-full sm:order-none sm:flex-1 sm:basis-auto',
                      // Hold the tab strip's height while the session resolves its worktree.
                      (sessionIdFromParams || selectedWorktreeId) &&
                        'min-h-10 [@media(any-pointer:coarse)]:min-h-14'
                    )}
                  >
                    {(canOpenTerminal || selectedWorktreeId) && (
                      <CloudAgentWorkspaceTabs
                        activeTabId={activeWorkspaceTabId}
                        activeTabRef={activeWorkspaceTabRef}
                        files={filesVisible ? workspaceTabs.files : []}
                        onCloseFile={handleCloseFileTab}
                        chatSessions={worktreeChats}
                        currentChatProgress={currentChatProgress}
                        currentChatLoadingLabel={currentChatLoadingLabel}
                        openChatSessionIds={openWorktreeChats.map(chat => chat.sessionId)}
                        closedChatSessionIds={closedWorktreeChats.map(chat => chat.sessionId)}
                        currentSessionId={sessionIdFromParams}
                        worktreeId={selectedWorktreeId}
                        onSelectChat={openSession}
                        onCloseChat={handleCloseChat}
                        onCreateChat={selectedWorktreeId ? handleCreateWorktreeChat : undefined}
                        canCreateChat={canCreateWorktreeChat}
                        onRenameChat={renameSession}
                        deletingSessionIds={deletingSessionIds}
                        terminals={workspaceTabs.terminals}
                        terminalStatuses={terminalStatuses}
                        canCreateTerminal={canOpenTerminal}
                        canOpenPreview={preview.links !== null}
                        onSelectTab={handleSelectWorkspaceTab}
                        onCreateTerminal={handleCreateTerminalTab}
                        onOpenPreview={preview.openDialog}
                        onCloseTerminal={handleCloseTerminalTab}
                        onActivateTab={closeChangesView}
                        selectionSuppressed={changesViewOpen}
                      />
                    )}
                  </div>
                  <WorktreeReviewDialog review={review} onOpenComment={handleOpenReviewComment} />
                  {preview.dialog !== null && <PreviewPortDialog {...preview.dialog} />}
                  {(sessionIdFromParams || workspaceControlSession) && (
                    <div
                      className={cn(
                        // Reserve the late-loading Changes and sandbox controls, which are
                        // touch-sized below `sm`, so they do not resize the header row.
                        'ml-auto flex min-h-11 shrink-0 items-center justify-end sm:min-h-8',
                        (sessionIdFromParams || selectedWorktreeId) && 'min-w-[188px] sm:min-w-0'
                      )}
                    >
                      {sessionActions}
                    </div>
                  )}
                </div>

                <div
                  ref={setChildSessionDrawerContainer}
                  className="relative flex min-h-0 flex-1 flex-col"
                >
                  <div
                    inert={childSessionStack.length > 0 || preparationDrawerAttemptId !== null}
                    className={changesViewOpen ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
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
                                  onClick={handleCreateWorktreeChat}
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
                            className="absolute inset-0 overflow-x-hidden overflow-y-auto px-[max(1rem,calc(50%_-_27rem))] py-2"
                            onScroll={handleScroll}
                          >
                            <div ref={messagesContentRef}>
                              <div className="sr-only" aria-live="polite">
                                {olderArrivalAnnouncement}
                              </div>
                              {transcriptPhase !== 'opening' && (
                                <OlderMessagesHeader
                                  isLoadingOlderMessages={isLoadingOlderMessages}
                                  olderMessagesError={olderMessagesError}
                                  olderMessagesOmittedItemCount={olderMessagesOmittedItemCount}
                                  onRetry={requestOlderMessages}
                                />
                              )}
                              {transcriptPhase === 'opening' ? (
                                <div
                                  role="status"
                                  aria-busy="true"
                                  className="flex flex-col gap-3 py-2"
                                >
                                  <span className="sr-only">Loading session…</span>
                                  <Skeleton className="h-3 w-2/3 motion-reduce:animate-none" />
                                  <Skeleton className="h-3 w-1/2 motion-reduce:animate-none" />
                                </div>
                              ) : transcriptPhase === 'failed' ? null : (
                                <PreviewLinksContext.Provider value={preview.links}>
                                  <ConversationMessages
                                    active={chatTabActive}
                                    isStreaming={isStreaming}
                                    {...shownTranscript}
                                    preparationByMessageId={preparationByMessageId}
                                    commitsAfterMessage={commitsAfterMessage}
                                    getChildMessages={getChildMessages}
                                    onOpenChildSession={handleOpenTopLevelChildSession}
                                    onOpenPreparationDetails={handleOpenPreparationDetails}
                                  />

                                  {localFailure ? (
                                    <LocalChatFailure
                                      session={localFailure}
                                      onRetry={() => retryLocalChat(localFailure.kiloSessionId)}
                                      onDiscard={() => discardLocalChat(localFailure.kiloSessionId)}
                                    />
                                  ) : (
                                    <TranscriptStatusSlot
                                      yieldToPreparationRow={preparationRowShowsProgress}
                                      workingMessages={
                                        chatTabActive &&
                                        isStreaming &&
                                        visibleStatusIndicator?.type !== 'warning'
                                          ? dynamicMessages
                                          : null
                                      }
                                      indicator={
                                        shownBillingFailure || slotStatusIndicator?.type === 'error'
                                          ? null
                                          : slotStatusIndicator
                                      }
                                    />
                                  )}
                                </PreviewLinksContext.Provider>
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
                          !isLoading &&
                          sessionIdFromParams &&
                          fetchedSessionData &&
                          transcriptPhase !== 'opening' ? (
                            <SessionContinuationPanel sessionId={sessionIdFromParams} />
                          ) : null
                        ) : (
                          <>
                            {activeQuestion && transcriptPhase !== 'opening' && (
                              <div className="border-t px-[max(1rem,calc(50%_-_27rem))] py-4">
                                <QuestionToolCard
                                  key={activeQuestion.requestId}
                                  questions={activeQuestion.questions}
                                  requestId={activeQuestion.requestId}
                                  status="running"
                                />
                              </div>
                            )}
                            {activePermission && transcriptPhase !== 'opening' && (
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
                              {transcriptPhase !== 'opening' && shownBillingFailure && (
                                <div className="px-[max(1rem,calc(50%_-_27rem))] pb-2">
                                  <CloudAgentBillingError
                                    failure={shownBillingFailure}
                                    presentation={billingPayerPresentation(shownBillingFailure, {
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
                              <div className="px-[max(1rem,calc(50%_-_27rem))]">
                                <CurrentTaskList todos={currentTodos} />
                              </div>
                              <ChatInput
                                inputRef={composerInputRef}
                                onSend={handleSendMessage}
                                onSendCommand={handleSendSlashCommand}
                                onNewChat={
                                  canCreateWorktreeChat ? handleReplaceWorktreeChat : undefined
                                }
                                onStop={handleStopExecution}
                                canInterrupt={canInterrupt}
                                conversationKey={sessionIdFromParams ?? 'new'}
                                disabled={
                                  !canSend ||
                                  isLoading ||
                                  transcriptPhase === 'opening' ||
                                  activeSessionType === null
                                }
                                sendUnavailableReason={
                                  transcriptPhase === 'local'
                                    ? localFailure
                                      ? undefined
                                      : 'Creating session…'
                                    : chatOpening
                                      ? 'Loading session…'
                                      : undefined
                                }
                                textareaDisabled={composerTextareaDisabled}
                                isStreaming={
                                  (isStreaming || activity.type === 'retrying') && !activeSuggestion
                                }
                                placeholder="Ask anything…"
                                slashCommands={availableCommands}
                                mode={modeControlValue(composerSettings?.mode ?? null)}
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
                                attachmentsEnabled={
                                  supportsAttachments || transcriptPhase === 'local'
                                }
                                attachmentUploadOptions={{
                                  messageUuid: attachmentMessageUuid,
                                  organizationId,
                                  getUploadUrl: {
                                    personal: personalUploadUrl,
                                    organization: orgUploadUrl,
                                  },
                                }}
                              />
                              {transcriptPhase !== 'opening' &&
                                !billingFailure &&
                                statusIndicator?.type === 'error' && (
                                  <div
                                    className="px-[max(1rem,calc(50%_-_27rem))] pb-2"
                                    role="alert"
                                  >
                                    <SessionStatusIndicator indicator={statusIndicator} />
                                  </div>
                                )}
                              <ComposerContextLine
                                reserve={Boolean(sessionIdFromParams)}
                                repository={composerRepository}
                                branch={composerBranch}
                                contextTokens={contextUsage?.contextTokens}
                                contextWindow={contextWindow}
                              />
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
                      changesCloudSessionId &&
                      workspaceTabs.files.map(tab => {
                        const tabId = fileTabId(tab.path);
                        const active = activeWorkspaceTabId === tabId;
                        return (
                          <TabsContent key={tabId} value={tabId} className="m-0 min-h-0 flex-1">
                            {active && !changesViewOpen && (
                              <WorktreeFilePane
                                cloudAgentSessionId={changesCloudSessionId}
                                organizationId={organizationId}
                                worktreeId={selectedWorktreeId ?? undefined}
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
                  {canOpenChanges && changesCloudSessionId && (
                    <WorktreeChangesView
                      key={fileScope}
                      cloudAgentSessionId={changesCloudSessionId}
                      organizationId={organizationId}
                      worktreeId={selectedWorktreeId ?? undefined}
                      open={changesViewOpen}
                      commentCounts={reviewCommentCounts}
                      review={review.scope ? review.bindings : undefined}
                      reviewScope={review.scope ?? undefined}
                    />
                  )}
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
          </div>
        </SuggestionContextProvider>
      </PermissionContextProvider>
    </QuestionContextProvider>
  );
}

export { CloudChatPage };

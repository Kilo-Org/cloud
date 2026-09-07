/* eslint-disable max-lines -- the session test renders the full SessionDetailContent and mocks its RN/expo/SDK surface, so the wiring is long. */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/app/(app)/agent-chat/[session-id].mounted.test.tsx. */
/* eslint-disable require-await, @typescript-eslint/require-await -- mock factories settle without await because they resolve immediately */
import { createElement, type ElementType, type ReactElement } from 'react';
import { Modal, Pressable } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type KiloSessionId, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import type * as ReactI18next from 'react-i18next';

import { type SessionTranscriptItem } from '@/components/agents/session-transcript';
import { SessionMessageList } from '@/components/agents/session-message-list';
import { MessageDetailsSheet } from '@/components/agents/message-details-sheet';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import { assistantMessage } from './message-bubble-test-utils';

const hoisted = vi.hoisted(() => {
  const draft = { text: '', files: [] as unknown[] };
  return {
    managerRef: { current: null as unknown },
    announce: vi.fn(),
    chatComposer: {
      draft,
      control: {
        hasContent: vi.fn(() => draft.text !== '' || draft.files.length > 0),
        setText: vi.fn((text: string) => {
          draft.text = text;
        }),
        restoreAttachments: vi.fn((files: unknown[]) => {
          draft.files = [...files];
        }),
      },
      lastProps: null as null | {
        onSend?: (text: string, options?: Record<string, unknown>) => Promise<void> | void;
      },
    },
  };
});

// Mock every RN / Expo / SDK side-effect import that `mobile-session-manager.ts`
// and `session-detail-content.tsx` pull in transitively before loading either
// module.
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
}));
vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@kilocode/cloud-agent-sdk', () => ({
  createSessionManager: vi.fn(),
}));
vi.mock('@kilocode/cloud-agent-sdk/preparation-attempts', () => ({
  isNoOpCompletedPreparationAttempt: () => false,
}));
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: vi.fn(() => 'test-token'),
}));
vi.mock('@/components/agents/mobile-session-transport-payload', () => ({
  normalizeTransportPayload: vi.fn((x: unknown) => x),
}));
vi.mock('@/components/agents/mobile-session-diagnostics', () => ({
  formatSafeCloudAgentFailureDiagnostic: vi.fn(),
  withCloudAgentDiagnostics: vi.fn((_op: string, _org: unknown, fn: () => unknown) => fn()),
}));
vi.mock('@/components/agents/mobile-session-page-adapter', () => ({
  fetchMobileSessionSnapshotPage: vi.fn(),
}));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
  CLOUD_AGENT_WS_URL: 'wss://ws.test',
  WEB_BASE_URL: 'https://web.test',
}));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: vi.fn(() => ({})),
}));
vi.mock('@/components/agents/tool-card-image-cache', () => ({
  cacheToolAttachment: vi.fn(),
  cacheToolCardImage: vi.fn(),
}));
vi.mock('@/components/agents/file-part-cache', () => ({
  cacheFilePart: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: { reportContent: { mutationOptions: (options: unknown) => options } },
  }),
  trpcClient: {
    cloudAgentNext: {
      getAttachmentDownloadUrl: { mutate: vi.fn() },
      prepareSession: { mutate: vi.fn() },
      sendMessage: { mutate: vi.fn() },
      cancelQueuedMessage: { mutate: vi.fn() },
    },
    organizations: {
      cloudAgentNext: {
        prepareSession: { mutate: vi.fn() },
        sendMessage: { mutate: vi.fn() },
        cancelQueuedMessage: { mutate: vi.fn() },
      },
    },
    cliSessionsV2: {
      getWithRuntimeState: { query: vi.fn() },
    },
  },
}));

// ── react-native / native bridges ──────────────────────────────────────────
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Modal: 'Modal',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@tanstack/react-query', () => ({ useMutation: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#000', mutedForeground: '#999' }),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/agents/message-text-select-sheet', () => ({
  MessageTextSelectSheet: 'MessageTextSelectSheet',
}));
vi.mock('expo-router', () => ({
  useFocusEffect: vi.fn(),
  useIsFocused: () => true,
  useRouter: () => ({ replace: vi.fn() }),
}));

// `useStackSafeReplace` owns the push + post-transition stack cleanup that keeps
// Android Fabric alive (KILO-APP-25); its own mechanics are covered in
// src/lib/navigation/stack-safe-replace.mounted.test.tsx. Here it stands in for
// the navigation call so these assertions stay about the destination href.
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: vi.fn() }),
}));
vi.mock('expo-keep-awake', () => ({
  useKeepAwake: vi.fn(),
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  NotificationFeedbackType: { Error: 'error', Success: 'success' },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  LinearTransition: { duration: () => ({}) },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

// ── jotai + session provider ───────────────────────────────────────────────
vi.mock('jotai', () => ({
  useAtomValue: (atom: { value: unknown }) => atom.value,
  useSetAtom: () => vi.fn(),
  useStore: () => ({ get: (atom: { value: unknown }) => atom.value, sub: vi.fn(() => vi.fn()) }),
}));
vi.mock('@/components/agents/session-provider', () => ({
  useSessionManager: () => hoisted.managerRef.current,
}));

// ── hooks and libs ─────────────────────────────────────────────────────────
vi.mock('@/lib/utils', () => ({
  cn: (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' '),
}));
vi.mock('@/lib/intl-cache', () => ({
  dateTimeFormat: vi.fn(() => ({ format: () => '' })),
  relativeTimeFormat: vi.fn(() => ({ format: () => '' })),
}));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  MESSAGE_SENT_EVENT: 'message_sent',
  SESSION_VIEWED_EVENT: 'session_viewed',
}));
vi.mock('@/lib/a11y/announce', () => ({
  moveA11yFocus: () => false,
  announceForA11y: hoisted.announce,
}));
vi.mock('@/lib/persist/drafts', () => ({
  agentComposerDraftKey: (id: string) => `agent-composer:${id}`,
}));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ settled: true, value: null }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ isLoading: false, userId: undefined }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ isLoading: false, models: [] }),
}));
vi.mock('@/lib/hooks/use-model-preferences', () => ({
  useModelPreferences: () => ({ setLastSelected: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-persisted-agent-model', () => ({
  usePersistedAgentModel: () => ({ saveModel: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-keep-screen-on-preference', () => ({
  useKeepScreenOnPreference: () => ({ hasLoaded: true, keepScreenOn: false }),
}));
vi.mock('@/lib/hooks/use-reasoning-preference', () => ({
  useReasoningPreference: () => ({ defaultExpanded: false }),
}));
vi.mock('@/lib/hooks/use-session-model-options', () => ({
  createRemoteModelOverride: vi.fn(),
  revalidateLegacyGatewayOverride: vi.fn(),
  useSessionModelOptions: () => ({ options: [], selectedValue: null, selectedVariant: null }),
}));
vi.mock('@/lib/use-github-repos-refresh', () => ({
  useGitHubReposRefresh: () => ({ openGitHubIntegration: vi.fn() }),
}));
vi.mock('@/lib/session-context-info', () => ({
  resolveSessionContextInfo: () => null,
}));
vi.mock('@/lib/picker-bridge', () => ({
  areModelPickerSelectionScopesEqual: () => true,
}));

// ── agent hooks ────────────────────────────────────────────────────────────
vi.mock('@/components/agents/use-continue-session', () => ({
  useContinueSession: () => ({
    clearGuidance: vi.fn(),
    continueSession: vi.fn(),
    guidance: null,
    isContinuing: false,
  }),
}));
vi.mock('@/components/agents/use-interaction-handlers', () => ({
  useInteractionHandlers: () => ({
    handleAnswerQuestion: vi.fn(),
    handleRejectQuestion: vi.fn(),
    handleRespondToPermission: vi.fn(),
    isAnswering: false,
    isRespondingToPermission: false,
    permissionSubmissionError: null,
    questionSubmissionError: null,
  }),
}));
vi.mock('@/components/agents/use-session-config-sync', () => ({
  useSessionConfigSync: () => ({
    currentMode: 'code',
    currentModel: undefined,
    currentVariant: '',
    setCurrentMode: vi.fn(),
    setCurrentModel: vi.fn(),
    setCurrentVariant: vi.fn(),
  }),
}));
vi.mock('@/components/agents/use-session-detail-rename', () => ({
  useSessionDetailRename: () => ({
    closeModal: vi.fn(),
    isModalOpen: false,
    isTitleInteractive: false,
    modalInitialValue: '',
    openModal: vi.fn(),
    submit: vi.fn(),
    title: 'Test session',
  }),
}));
vi.mock('@/components/kilo-chat/hooks/use-cli-session-presence', () => ({
  resolveLoadedCliSessionPresenceId: () => null,
  useCliSessionPresence: vi.fn(),
}));

// ── pure helpers the component still calls ────────────────────────────────
vi.mock('@/components/agents/agent-interaction-policy', () => ({
  getBlockingInteraction: () => 'none',
}));
vi.mock('@/components/agents/mode-normalize', () => ({
  customModeOptionsFromRuntimeAgents: () => [],
  dedupeCustomModeOptions: (options: unknown) => options,
  ensureSelectedCustomOption: (options: unknown) => options,
  lockedModelOption: () => ({}),
  resolvePinnedAgentModel: () => ({}),
}));
vi.mock('@/components/agents/queued-badge-hold', () => ({
  nextHeldQueuedIds: (held: unknown) => held,
}));
vi.mock('@/components/agents/session-keyboard-container-state', () => ({
  getSessionKeyboardContainerKind: () => 'app-aware-padding',
}));
vi.mock('@/components/agents/context-usage-display', () => ({
  getContextSheetMountState: () => ({ mounted: false, visible: false }),
}));
vi.mock('@/components/agents/session-composer-disabled', () => ({
  resolveSessionComposerDisabled: () => false,
}));
vi.mock('@/components/agents/session-list-helpers', () => ({
  selectSessionCostInputs: () => ({ breakdownCostUsd: null, totalMicrodollars: null }),
}));
vi.mock('@/components/agents/mobile-session-manager-helpers', () => ({
  buildRemoteAttachmentParts: vi.fn(),
}));
vi.mock('@/components/agents/session-working-state', () => ({
  shouldShowAgentWorkingIndicator: () => false,
  shouldShowFooterWorkingIndicator: () => false,
  shouldShowSessionFooterRow: () => false,
}));
vi.mock('@/components/agents/session-keep-awake', () => ({
  shouldKeepSessionAwake: () => false,
}));
vi.mock('@/components/agents/session-focus-refetch', () => ({
  shouldRefetchOnFocus: () => false,
}));
vi.mock('@/components/agents/session-terminal-error', () => ({
  buildTerminalErrorCopyText: () => '',
  resolveSessionTerminalError: () => null,
}));
vi.mock('@/components/agents/child-session-card-state', () => ({
  getChildSessionStreaming: () => false,
}));
vi.mock('@/components/agents/child-session-sheet-state', () => ({
  closeChildSessionSheet: vi.fn(),
  openChildSessionSheet: vi.fn(),
  releaseChildSessionSheet: vi.fn(),
}));
vi.mock('@/components/agents/use-message-copy', () => ({
  performCopy: vi.fn(),
}));
vi.mock('@/components/agents/session-detail-content-helpers', () => ({
  countInFlightMessages: () => 0,
  resolveRetryPrompt: () => null,
  retryMessageAndClear: vi.fn(),
}));
vi.mock('@/components/agents/create-and-navigate-agent-session', () => ({
  createAndNavigateAgentSession: vi.fn(),
}));
vi.mock('@/components/agents/exit-remote-session-with-feedback', () => ({
  exitRemoteSessionWithFeedback: vi.fn(),
}));
vi.mock('@/components/agents/restart-agent-session', () => ({
  restartAgentSession: vi.fn(),
}));

// ── sub-components ─────────────────────────────────────────────────────────
// ChatComposer is the only non-string mock: it binds the composer control
// handle and captures its props so the suite can drive `onSend`.
vi.mock('@/components/agents/chat-composer', async () => {
  const React = await import('react');
  return {
    ChatComposer: (props: {
      controlRef?: React.Ref<unknown>;
      onSend?: (text: string, options?: Record<string, unknown>) => Promise<void> | void;
    }) => {
      hoisted.chatComposer.lastProps = props;
      React.useImperativeHandle(props.controlRef, () => hoisted.chatComposer.control);
      return React.createElement('ChatComposer', null);
    },
  };
});
vi.mock('@/components/agents/message-bubble', () => ({
  MessageBubble: 'MessageBubble',
}));
vi.mock('@/components/agents/session-message-list', () => ({
  SessionMessageList: 'SessionMessageList',
}));
vi.mock('@/components/agents/model-selector', () => ({
  ModelPickerSelectionScopeProvider: 'ModelPickerSelectionScopeProvider',
}));
vi.mock('@/components/agents/permission-card', () => ({
  PermissionCard: 'PermissionCard',
}));
vi.mock('@/components/agents/question-card', () => ({
  QuestionCard: 'QuestionCard',
}));
vi.mock('@/components/agents/session-connection-indicator', () => ({
  SessionConnectionIndicator: 'SessionConnectionIndicator',
}));
vi.mock('@/components/agents/session-context-metrics', () => ({
  SessionContextMetrics: 'SessionContextMetrics',
}));
vi.mock('@/components/agents/session-context-sheet', () => ({
  SessionContextSheet: 'SessionContextSheet',
}));
vi.mock('@/components/agents/session-pr-badge', () => ({
  SessionPrBadge: 'SessionPrBadge',
}));
vi.mock('@/components/agents/session-status-indicator', () => ({
  SessionStatusIndicator: 'SessionStatusIndicator',
}));
vi.mock('@/components/agents/preparation-group', () => ({
  PreparationGroup: 'PreparationGroup',
}));
vi.mock('@/components/agents/session-detail-skeleton', () => ({
  SessionSkeletonMessages: 'SessionSkeletonMessages',
}));
vi.mock('@/components/agents/transcript-time-marker', () => ({
  TranscriptTimeMarker: 'TranscriptTimeMarker',
}));
vi.mock('@/components/agents/working-indicator', () => ({
  WorkingIndicator: 'WorkingIndicator',
}));
vi.mock('@/components/agents/child-session-sheet', () => ({
  ChildSessionSheet: 'ChildSessionSheet',
}));
vi.mock('@/components/agents/part-detail-sheet-host', () => ({
  PartDetailSheetHost: 'PartDetailSheetHost',
}));
vi.mock('@/components/agents/part-renderer', () => ({
  PartRenderer: 'PartRenderer',
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
}));
vi.mock('@/components/kilo-chat/app-aware-keyboard-padding', () => ({
  AppAwareKeyboardPaddingView: 'AppAwareKeyboardPaddingView',
}));
vi.mock('@/components/query-error', () => ({
  QueryError: 'QueryError',
}));
vi.mock('@/components/rename-modal', () => ({
  RenameModal: 'RenameModal',
}));
vi.mock('@/components/context-control', () => ({ ContextControl: 'ContextControl' }));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: 'ScreenHeader',
}));
vi.mock('@/components/ui/blur-bar', () => ({
  BlurBar: 'BlurBar',
}));
vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/components/ui/icons', () => ({
  MessageSquare: 'MessageSquare',
}));

const { SessionDetailContent } = await import('@/components/agents/session-detail-content');

const SESSION_ID = 'sess-1' as KiloSessionId;
const PERSONAL_DISPLAY_SCOPE = { organizationId: null, isResolved: true };

function makeManager() {
  return {
    atoms: {
      messagesList: { value: [] as StoredMessage[] },
      isLoading: { value: false },
      error: { value: null },
      fetchedSessionData: {
        value: {
          associatedPr: null,
          cloudAgentSessionId: undefined,
          gitUrl: undefined,
          kiloSessionId: SESSION_ID,
          mode: undefined,
          organizationId: undefined,
          title: 'Test session',
          totalCostMicrodollars: null,
        },
      },
      sessionConfig: { value: null },
      isStreaming: { value: false },
      statusIndicator: { value: null },
      agentStatus: { value: { type: 'connected' } },
      cloudStatus: { value: null },
      preparationAttempts: { value: [] },
      canSend: { value: true },
      isReadOnly: { value: false },
      supportsAttachments: { value: true },
      activeQuestion: { value: null },
      activePermission: { value: null },
      activeSuggestion: { value: null },
      pendingQuestions: { value: [] },
      pendingPermissions: { value: [] },
      totalCost: { value: null },
      childMessages: { value: () => new Map() },
      childSessionHydrationState: { value: () => ({ status: 'idle' }) },
      childSessionError: { value: () => null },
      pendingMessages: { value: new Map<string, { status: string }>() },
      activeSessionType: { value: null },
      remoteModelState: {
        value: { catalog: null, ownerConnectionId: null as string | null, protocol: 'v1' },
      },
      observedModel: { value: null },
      remoteModelOverride: { value: null },
      cloudAgentModelOverride: { value: null },
      availableCommands: { value: [] },
      remoteCommandState: { value: null },
      contextUsage: { value: null },
      hasOlderMessages: { value: false },
      isLoadingOlderMessages: { value: false },
      olderMessagesError: { value: null },
      olderMessagesOmittedItemCount: { value: 0 },
    },
    switchSession: vi.fn(),
    send: vi.fn(),
    cancelQueuedMessage: vi.fn(),
    acceptSuggestion: vi.fn(),
    dismissSuggestion: vi.fn(),
    interrupt: vi.fn(),
    setCloudAgentModelOverride: vi.fn(),
    setRemoteModelOverride: vi.fn(),
    updateFetchedAssociatedPr: vi.fn(),
    hydrateChildSession: vi.fn(),
    loadOlderMessages: vi.fn(),
    trimRetainedHistory: vi.fn(),
    loadOlderChildMessages: vi.fn(),
    clearFailedMessage: vi.fn(),
    createRemoteSession: vi.fn(),
    exitRemoteSession: vi.fn(),
    destroy: vi.fn(),
  };
}

type TestManager = ReturnType<typeof makeManager>;

let currentManager: TestManager = makeManager();

const TEXT_PART = { type: 'text', text: 'Queued prompt' } as const;
const FILE_PART = {
  type: 'file',
  filename: 'a.pdf',
  mime: 'application/pdf',
  url: 'file:///tmp/attachments/sess-1/user-1/msg-1/a.pdf',
} as const;

function queuedMessage(parts: readonly unknown[] = [TEXT_PART]): StoredMessage {
  return {
    info: { id: 'msg-queued-1', role: 'user', time: { created: undefined } },
    parts,
  } as unknown as StoredMessage;
}

function mount(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionDetailContent, {
        sessionId: SESSION_ID,
        displayScope: PERSONAL_DISPLAY_SCOPE,
      })
    );
  });
  if (!ref.current) {
    throw new Error('SessionDetailContent did not render');
  }
  return ref.current;
}

function findByType(
  renderer: TestRenderer.ReactTestRenderer,
  type: ElementType
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAllByType(type);
}

/** Reads the MessageBubble element the current transcript renders for `messageId`. */
function readBubble(
  renderer: TestRenderer.ReactTestRenderer,
  messageId: string
): ReactElement | undefined {
  const lists = findByType(renderer, SessionMessageList);
  const listProps = lists[0]?.props as
    | {
        items?: SessionTranscriptItem[];
        renderItem?: (args: { item: SessionTranscriptItem }) => ReactElement;
      }
    | undefined;
  const item = listProps?.items?.find(
    candidate => candidate.type === 'message' && candidate.message.info.id === messageId
  );
  if (!item || !listProps?.renderItem) {
    return undefined;
  }
  return listProps.renderItem({ item });
}

function bubbleProps(
  renderer: TestRenderer.ReactTestRenderer,
  messageId: string
): Record<string, unknown> {
  return (readBubble(renderer, messageId)?.props ?? {}) as Record<string, unknown>;
}

function detailsProps(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType(MessageDetailsSheet).props as Parameters<
    typeof MessageDetailsSheet
  >[0];
}

function cancellationRow(renderer: TestRenderer.ReactTestRenderer) {
  return findByType(renderer, Pressable).find(
    node => node.props.testID === 'message-details-cancel-queued'
  );
}

function cancellationPress(renderer: TestRenderer.ReactTestRenderer): () => void {
  const row = cancellationRow(renderer);
  if (!row) {
    throw new Error('Cancellation row is missing');
  }
  return row.props.onPress as () => void;
}

function openDetails(renderer: TestRenderer.ReactTestRenderer, message: StoredMessage): void {
  const open = bubbleProps(renderer, message.info.id).onLongPressDetails as (
    message: StoredMessage
  ) => void;
  act(() => {
    open(message);
  });
}

function closeDetails(renderer: TestRenderer.ReactTestRenderer): void {
  const close = findByType(renderer, Modal)[0]?.props.onRequestClose as () => void;
  act(() => {
    close();
  });
}

function updateScreen(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    renderer.update(
      createElement(SessionDetailContent, {
        sessionId: SESSION_ID,
        displayScope: PERSONAL_DISPLAY_SCOPE,
      })
    );
  });
}

function unmountScreen(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    renderer.unmount();
  });
}

function statusMessages(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(AccessibleStatus)
    .map(node => node.props.message as string | null)
    .filter(message => message !== null);
}

beforeEach(() => {
  currentManager = makeManager();
  hoisted.managerRef.current = currentManager;
  hoisted.chatComposer.lastProps = null;
  hoisted.chatComposer.draft.text = '';
  hoisted.chatComposer.draft.files = [];
  hoisted.chatComposer.control.hasContent.mockClear();
  hoisted.chatComposer.control.setText.mockClear();
  hoisted.chatComposer.control.restoreAttachments.mockClear();
  hoisted.announce.mockClear();
});

describe('SessionDetailContent cancel/restore', () => {
  function seedQueuedMessage(message: StoredMessage = queuedMessage()): void {
    currentManager.atoms.messagesList.value = [message];
    currentManager.atoms.pendingMessages.value = new Map([[message.info.id, { status: 'queued' }]]);
  }

  const failed = 'agentChat.session.cancelQueuedFailed';
  const restored = 'agentChat.session.cancelQueuedRestored';
  const restoreAvailable = 'agentChat.session.cancelQueuedRestoreAvailable';

  it('exposes no cancellation without a selected message', () => {
    seedQueuedMessage();
    const renderer = mount();
    expect(detailsProps(renderer).visible).toBe(false);
    expect(detailsProps(renderer).message).toBeNull();
    expect(cancellationRow(renderer)).toBeUndefined();
    unmountScreen(renderer);
  });

  it.each([
    'accepted',
    'running',
    'canceled',
    'failed',
    'missing',
    'assistant',
    'untracked',
    'future',
  ])('rejects stale activation and updates the open sheet for %s', async state => {
    const message = queuedMessage();
    seedQueuedMessage(message);
    const renderer = mount();
    openDetails(renderer, message);
    const stalePress = cancellationPress(renderer);
    expect(detailsProps(renderer).canCancelQueued).toBe(true);
    if (state === 'missing') {
      currentManager.atoms.messagesList.value = [];
    } else if (state === 'assistant') {
      currentManager.atoms.messagesList.value = [assistantMessage(message.info.id)];
    } else if (state === 'untracked') {
      currentManager.atoms.pendingMessages.value = new Map();
    } else {
      currentManager.atoms.pendingMessages.value = new Map([[message.info.id, { status: state }]]);
    }
    await act(async () => {
      stalePress();
      await Promise.resolve();
    });
    updateScreen(renderer);
    expect(detailsProps(renderer).canCancelQueued).toBe(false);
    expect(cancellationRow(renderer)).toBeUndefined();
    expect(detailsProps(renderer).message).toBe(currentManager.atoms.messagesList.value[0] ?? null);
    expect(currentManager.cancelQueuedMessage).not.toHaveBeenCalled();
    expect(hoisted.chatComposer.draft).toEqual({ text: '', files: [] });
    expect(statusMessages(renderer)).toEqual([]);
    seedQueuedMessage(message);
    updateScreen(renderer);
    expect(detailsProps(renderer).canCancelQueued).toBe(true);
    expect(cancellationRow(renderer)).toBeDefined();
    unmountScreen(renderer);
  });

  it('uses current message parts rather than the selected snapshot at invocation', async () => {
    const selected = queuedMessage();
    seedQueuedMessage(selected);
    currentManager.cancelQueuedMessage.mockResolvedValue({ dropped: true });
    const renderer = mount();
    openDetails(renderer, selected);
    const press = cancellationPress(renderer);
    const current = queuedMessage([{ ...TEXT_PART, text: 'Current prompt' }, FILE_PART]);
    currentManager.atoms.messagesList.value = [current];
    await act(async () => {
      press();
      await Promise.resolve();
    });
    expect(hoisted.chatComposer.draft).toEqual({ text: 'Current prompt', files: [FILE_PART] });
    expect(readBubble(renderer, selected.info.id)).toBeUndefined();
    expect(statusMessages(renderer)).toEqual([]);
    unmountScreen(renderer);
  });

  describe.each([false, true])('composer occupied=%s', occupied => {
    it.each([
      { name: 'text', parts: [TEXT_PART], text: 'Queued prompt', files: [] },
      {
        name: 'text and files',
        parts: [TEXT_PART, FILE_PART],
        text: 'Queued prompt',
        files: [FILE_PART],
      },
      { name: 'file-only', parts: [FILE_PART], text: '', files: [FILE_PART] },
    ])('cancels $name once and preserves its restoration path', async ({ parts, text, files }) => {
      const message = queuedMessage(parts);
      seedQueuedMessage(message);
      const request = Promise.withResolvers<{ dropped: boolean }>();
      currentManager.cancelQueuedMessage.mockReturnValue(request.promise);
      const original = {
        text: occupied ? 'Existing draft' : '',
        files: occupied ? [{ filename: 'draft.txt' }] : [],
      };
      Object.assign(hoisted.chatComposer.draft, original);
      const renderer = mount();
      openDetails(renderer, message);
      const press = cancellationPress(renderer);
      act(() => {
        press();
        press();
      });
      expect(currentManager.cancelQueuedMessage.mock.calls).toEqual([[message.info.id]]);
      expect(detailsProps(renderer).canCancelQueued).toBe(false);
      expect(detailsProps(renderer).isCancelingQueued).toBe(true);
      expect(cancellationRow(renderer)?.props.accessibilityState).toEqual({
        disabled: true,
        busy: true,
      });
      expect(hoisted.chatComposer.draft).toEqual(original);
      await act(async () => {
        request.resolve({ dropped: true });
        await request.promise;
        press();
      });
      expect(currentManager.cancelQueuedMessage.mock.calls).toEqual([[message.info.id]]);
      expect(detailsProps(renderer).visible).toBe(false);
      expect(statusMessages(renderer)).toEqual([]);
      expect(hoisted.announce.mock.calls).toEqual([[occupied ? restoreAvailable : restored]]);
      if (occupied) {
        expect(hoisted.chatComposer.draft).toEqual(original);
        expect(hoisted.chatComposer.control.setText).not.toHaveBeenCalled();
        expect(hoisted.chatComposer.control.restoreAttachments).not.toHaveBeenCalled();
        expect(bubbleProps(renderer, message.info.id).deliveryState).toBeUndefined();
        expect(bubbleProps(renderer, message.info.id).onRestoreQueued).toBeInstanceOf(Function);
        openDetails(renderer, message);
        expect(detailsProps(renderer).canCancelQueued).toBe(false);
        expect(cancellationRow(renderer)).toBeUndefined();
        closeDetails(renderer);
        currentManager.atoms.messagesList.value = [];
        currentManager.atoms.pendingMessages.value = new Map();
        updateScreen(renderer);
        const restore = bubbleProps(renderer, message.info.id).onRestoreQueued as (
          message: StoredMessage
        ) => void;
        expect(restore).toBeInstanceOf(Function);
        act(() => {
          restore(message);
        });
        expect(statusMessages(renderer)).toEqual([]);
        expect(hoisted.announce.mock.calls).toEqual([[restoreAvailable], [restored]]);
      }
      expect(hoisted.chatComposer.draft).toEqual({ text: text || original.text, files });
      expect(hoisted.chatComposer.control.setText).toHaveBeenCalledTimes(text ? 1 : 0);
      expect(hoisted.chatComposer.control.restoreAttachments).toHaveBeenCalledTimes(1);
      expect(readBubble(renderer, message.info.id)).toBeUndefined();
      unmountScreen(renderer);
    });

    it.each(['false', 'rejection'])(
      'preserves the message and composer after retryable %s with matching sheet feedback',
      async outcome => {
        const message = queuedMessage([TEXT_PART, FILE_PART]);
        seedQueuedMessage(message);
        const original = {
          text: occupied ? 'Keep my draft' : '',
          files: occupied ? [{ filename: 'draft.txt' }] : [],
        };
        Object.assign(hoisted.chatComposer.draft, original);
        if (outcome === 'false') {
          currentManager.cancelQueuedMessage.mockResolvedValue({ dropped: false });
        } else {
          currentManager.cancelQueuedMessage.mockRejectedValue(
            Object.assign(new Error(outcome), { code: 'SERVICE_UNAVAILABLE' })
          );
        }
        const renderer = mount();
        openDetails(renderer, message);
        await act(async () => {
          cancellationPress(renderer)();
          await Promise.resolve();
        });
        expect(hoisted.chatComposer.draft).toEqual(original);
        expect(currentManager.atoms.messagesList.value).toEqual([message]);
        expect(readBubble(renderer, message.info.id)).toBeDefined();
        expect(bubbleProps(renderer, message.info.id).onRestoreQueued).toBeUndefined();
        expect(detailsProps(renderer).canCancelQueued).toBe(true);
        expect(detailsProps(renderer).isCancelingQueued).toBe(false);
        expect(detailsProps(renderer).cancelQueuedFeedback?.message).toBe(failed);
        expect(statusMessages(renderer)).toEqual([failed]);
        expect(findByType(renderer, Text).map(node => node.props.children)).toContain(failed);
        expect(hoisted.announce.mock.calls).toEqual([[failed]]);
        expect(currentManager.interrupt).not.toHaveBeenCalled();
        expect(hoisted.chatComposer.control.restoreAttachments).not.toHaveBeenCalled();
        unmountScreen(renderer);
      }
    );

    it('retains upgrade guidance and blocks unsupported cancellation across message selections', async () => {
      const message = queuedMessage([TEXT_PART, FILE_PART]);
      const second = { ...message, info: { ...message.info, id: 'msg-queued-2' } };
      currentManager.atoms.messagesList.value = [message, second];
      currentManager.atoms.pendingMessages.value = new Map(
        [message, second].map(item => [item.info.id, { status: 'queued' }])
      );
      const original = {
        text: occupied ? 'Keep my draft' : '',
        files: occupied ? [{ filename: 'draft.txt' }] : [],
      };
      Object.assign(hoisted.chatComposer.draft, original);
      const request = Promise.withResolvers<{ dropped: boolean }>();
      currentManager.cancelQueuedMessage
        .mockReturnValueOnce(request.promise)
        .mockResolvedValue({ dropped: true });
      const renderer = mount();
      openDetails(renderer, second);
      const staleSecondPress = cancellationPress(renderer);
      openDetails(renderer, message);
      const stalePress = cancellationPress(renderer);
      act(() => {
        stalePress();
      });
      await act(async () => {
        request.reject(
          Object.assign(new Error('Upgrade required'), { code: 'CLI_UPGRADE_REQUIRED' })
        );
        await Promise.resolve();
        stalePress();
        staleSecondPress();
      });
      const upgrade = 'agentChat.session.cancelQueuedUpgradeRequired';
      expect(detailsProps(renderer).visible).toBe(true);
      expect(detailsProps(renderer).canCancelQueued).toBe(false);
      expect(detailsProps(renderer).isCancelingQueued).toBe(false);
      expect(cancellationRow(renderer)).toBeUndefined();
      expect(detailsProps(renderer).cancelQueuedFeedback?.message).toBe(upgrade);
      expect(statusMessages(renderer)).toEqual([upgrade]);
      expect(findByType(renderer, Text).map(node => node.props.children)).toContain(upgrade);
      closeDetails(renderer);
      openDetails(renderer, message);
      expect(cancellationRow(renderer)).toBeUndefined();
      expect(findByType(renderer, Text).map(node => node.props.children)).toContain(upgrade);
      expect(statusMessages(renderer)).toEqual([]);
      openDetails(renderer, second);
      expect(cancellationRow(renderer)).toBeUndefined();
      expect(findByType(renderer, Text).map(node => node.props.children)).toContain(upgrade);
      expect(statusMessages(renderer)).toEqual([]);
      expect(hoisted.chatComposer.draft).toEqual(original);
      expect(currentManager.atoms.messagesList.value).toEqual([message, second]);
      expect(readBubble(renderer, message.info.id)).toBeDefined();
      expect(readBubble(renderer, second.info.id)).toBeDefined();
      expect(bubbleProps(renderer, message.info.id).onRestoreQueued).toBeUndefined();
      expect(bubbleProps(renderer, second.info.id).onRestoreQueued).toBeUndefined();
      expect(currentManager.cancelQueuedMessage.mock.calls).toEqual([[message.info.id]]);
      expect(currentManager.interrupt).not.toHaveBeenCalled();
      expect(hoisted.chatComposer.control.restoreAttachments).not.toHaveBeenCalled();
      expect(hoisted.announce.mock.calls).toEqual([[upgrade]]);
      unmountScreen(renderer);
    });
  });

  it.each([false, true])(
    'restores cancellation only for a replacement CLI connection, sheet closed=%s',
    async closed => {
      const message = queuedMessage([TEXT_PART, FILE_PART]);
      seedQueuedMessage(message);
      currentManager.atoms.remoteModelState.value.ownerConnectionId = 'cli-1';
      currentManager.cancelQueuedMessage.mockRejectedValueOnce(
        Object.assign(new Error('Upgrade required'), { code: 'CLI_UPGRADE_REQUIRED' })
      );
      const renderer = mount();
      openDetails(renderer, message);
      const stalePress = cancellationPress(renderer);
      await act(async () => {
        stalePress();
        await Promise.resolve();
      });
      const upgrade = 'agentChat.session.cancelQueuedUpgradeRequired';
      expect(cancellationRow(renderer)).toBeUndefined();
      expect(hoisted.chatComposer.draft).toEqual({ text: '', files: [] });
      if (closed) {
        closeDetails(renderer);
        openDetails(renderer, message);
        expect(findByType(renderer, Text).map(node => node.props.children)).toContain(upgrade);
        expect(statusMessages(renderer)).toEqual([]);
      }

      for (const ownerConnectionId of ['cli-1', null, 'cli-1']) {
        currentManager.atoms.remoteModelState.value = {
          ...currentManager.atoms.remoteModelState.value,
          ownerConnectionId,
        };
        currentManager.atoms.agentStatus.value = {
          type: ownerConnectionId === null ? 'disconnected' : 'connected',
        };
        currentManager.atoms.supportsAttachments.value = ownerConnectionId !== null;
        updateScreen(renderer);
        act(() => {
          stalePress();
        });
        expect(cancellationRow(renderer)).toBeUndefined();
        expect(findByType(renderer, Text).map(node => node.props.children)).toContain(upgrade);
        expect(currentManager.cancelQueuedMessage.mock.calls).toEqual([[message.info.id]]);
        expect(hoisted.chatComposer.draft).toEqual({ text: '', files: [] });
      }
      if (closed) {
        closeDetails(renderer);
      }
      currentManager.atoms.remoteModelState.value = {
        ...currentManager.atoms.remoteModelState.value,
        ownerConnectionId: 'cli-2',
      };
      updateScreen(renderer);
      if (closed) {
        openDetails(renderer, message);
      }
      expect(detailsProps(renderer).message).toBe(message);
      expect(cancellationRow(renderer)).toBeDefined();
      expect(detailsProps(renderer).canCancelQueued).toBe(true);
      expect(detailsProps(renderer).cancelQueuedFeedback).toBeNull();
      expect(findByType(renderer, Text).map(node => node.props.children)).not.toContain(upgrade);
      expect(hoisted.announce.mock.calls).toEqual([[upgrade]]);
      currentManager.cancelQueuedMessage.mockResolvedValue({ dropped: true });
      await act(async () => {
        cancellationPress(renderer)();
        await Promise.resolve();
      });
      expect(hoisted.chatComposer.draft).toEqual({ text: 'Queued prompt', files: [FILE_PART] });
      expect(readBubble(renderer, message.info.id)).toBeUndefined();
      expect(detailsProps(renderer).visible).toBe(false);
      expect(statusMessages(renderer)).toEqual([]);
      expect(hoisted.announce.mock.calls).toEqual([[upgrade], [restored]]);
      unmountScreen(renderer);
    }
  );

  it.each([false, true])(
    'reports a late upgrade failure once without disabling the replacement, sheet dismissed=%s',
    async dismissed => {
      const message = queuedMessage();
      seedQueuedMessage(message);
      currentManager.atoms.remoteModelState.value.ownerConnectionId = 'cli-1';
      const request = Promise.withResolvers<{ dropped: boolean }>();
      currentManager.cancelQueuedMessage.mockReturnValueOnce(request.promise);
      const renderer = mount();
      openDetails(renderer, message);
      act(() => {
        cancellationPress(renderer)();
      });
      if (dismissed) {
        closeDetails(renderer);
      }
      currentManager.atoms.remoteModelState.value = {
        ...currentManager.atoms.remoteModelState.value,
        ownerConnectionId: 'cli-2',
      };
      updateScreen(renderer);
      await act(async () => {
        request.reject(
          Object.assign(new Error('Upgrade required'), { code: 'CLI_UPGRADE_REQUIRED' })
        );
        await Promise.resolve();
      });
      expect(detailsProps(renderer).visible).toBe(!dismissed);
      expect(detailsProps(renderer).isCancelingQueued).toBe(false);
      expect(detailsProps(renderer).cancelQueuedFeedback?.message ?? null).toBe(
        dismissed ? null : failed
      );
      expect(detailsProps(renderer).cancelQueuedGuidance).toBeNull();
      expect(statusMessages(renderer)).toEqual([failed]);
      const visibleText = findByType(renderer, Text).map(node => node.props.children);
      expect(visibleText.filter(text => text === failed)).toHaveLength(1);
      expect(visibleText).not.toContain('agentChat.session.cancelQueuedUpgradeRequired');
      expect(hoisted.announce.mock.calls).toEqual([[failed]]);
      expect(hoisted.chatComposer.draft).toEqual({ text: '', files: [] });
      expect(readBubble(renderer, message.info.id)).toBeDefined();
      if (dismissed) {
        openDetails(renderer, message);
      }
      expect(detailsProps(renderer).canCancelQueued).toBe(true);
      expect(cancellationRow(renderer)?.props.accessibilityState).toEqual({
        disabled: false,
        busy: false,
      });
      expect(hoisted.announce.mock.calls).toEqual([[failed]]);
      currentManager.cancelQueuedMessage.mockResolvedValue({ dropped: true });
      await act(async () => {
        cancellationPress(renderer)();
        await Promise.resolve();
      });
      expect(hoisted.chatComposer.draft).toEqual({ text: 'Queued prompt', files: [] });
      expect(readBubble(renderer, message.info.id)).toBeUndefined();
      expect(detailsProps(renderer).visible).toBe(false);
      expect(statusMessages(renderer)).toEqual([]);
      expect(hoisted.announce.mock.calls).toEqual([[failed], [restored]]);
      unmountScreen(renderer);
    }
  );

  it('keeps the occupied Restore path usable before late delivery events', async () => {
    const message = queuedMessage([TEXT_PART, FILE_PART]);
    seedQueuedMessage(message);
    const request = Promise.withResolvers<{ dropped: boolean }>();
    currentManager.cancelQueuedMessage.mockReturnValue(request.promise);
    const renderer = mount();
    openDetails(renderer, message);
    act(() => {
      cancellationPress(renderer)();
    });
    const typedDraft = { text: 'Typed while waiting', files: [{ filename: 'draft.txt' }] };
    Object.assign(hoisted.chatComposer.draft, typedDraft);
    await act(async () => {
      request.resolve({ dropped: true });
      await request.promise;
    });
    expect(hoisted.chatComposer.draft).toEqual(typedDraft);
    expect(bubbleProps(renderer, message.info.id).deliveryState).toBeUndefined();
    const restore = bubbleProps(renderer, message.info.id).onRestoreQueued as (
      message: StoredMessage
    ) => void;
    act(() => {
      restore(message);
    });
    updateScreen(renderer);
    expect(hoisted.chatComposer.draft).toEqual({ text: 'Queued prompt', files: [FILE_PART] });
    expect(readBubble(renderer, message.info.id)).toBeUndefined();
    expect(currentManager.atoms.messagesList.value).toEqual([message]);
    expect(hoisted.announce.mock.calls).toEqual([[restoreAvailable], [restored]]);
    unmountScreen(renderer);
  });

  it.each(['success', 'upgrade'])(
    'ignores an old %s outcome in a different session',
    async outcome => {
      const message = queuedMessage();
      seedQueuedMessage(message);
      const request = Promise.withResolvers<{ dropped: boolean }>();
      currentManager.cancelQueuedMessage.mockReturnValue(request.promise);
      const renderer = mount();
      openDetails(renderer, message);
      act(() => {
        cancellationPress(renderer)();
      });
      const nextSessionId = 'sess-2' as KiloSessionId;
      const nextMessage = queuedMessage([{ ...TEXT_PART, text: 'Next session prompt' }]);
      seedQueuedMessage(nextMessage);
      currentManager.atoms.fetchedSessionData.value.kiloSessionId = nextSessionId;
      act(() => {
        renderer.update(
          createElement(SessionDetailContent, {
            sessionId: nextSessionId,
            displayScope: PERSONAL_DISPLAY_SCOPE,
          })
        );
      });
      await act(async () => {
        if (outcome === 'upgrade') {
          request.reject(
            Object.assign(new Error('Upgrade required'), { code: 'CLI_UPGRADE_REQUIRED' })
          );
        } else {
          request.resolve({ dropped: true });
        }
        await Promise.resolve();
      });
      expect(hoisted.chatComposer.draft).toEqual({ text: '', files: [] });
      expect(detailsProps(renderer).visible).toBe(false);
      expect(statusMessages(renderer)).toEqual([]);
      expect(hoisted.announce).not.toHaveBeenCalled();
      openDetails(renderer, nextMessage);
      expect(detailsProps(renderer).canCancelQueued).toBe(true);
      expect(cancellationRow(renderer)).toBeDefined();
      unmountScreen(renderer);
    }
  );

  it('does not carry known unsupported cancellation into a different session', async () => {
    const message = queuedMessage();
    seedQueuedMessage(message);
    currentManager.cancelQueuedMessage.mockRejectedValueOnce(
      Object.assign(new Error('Upgrade required'), { code: 'CLI_UPGRADE_REQUIRED' })
    );
    const renderer = mount();
    openDetails(renderer, message);
    await act(async () => {
      cancellationPress(renderer)();
      await Promise.resolve();
    });
    expect(cancellationRow(renderer)).toBeUndefined();
    const nextSessionId = 'sess-2' as KiloSessionId;
    const nextMessage = queuedMessage([{ ...TEXT_PART, text: 'Next session prompt' }]);
    seedQueuedMessage(nextMessage);
    currentManager.atoms.fetchedSessionData.value.kiloSessionId = nextSessionId;
    act(() => {
      renderer.update(
        createElement(SessionDetailContent, {
          sessionId: nextSessionId,
          displayScope: PERSONAL_DISPLAY_SCOPE,
        })
      );
    });
    openDetails(renderer, nextMessage);
    expect(statusMessages(renderer)).toEqual([]);
    currentManager.cancelQueuedMessage.mockResolvedValue({ dropped: true });
    await act(async () => {
      cancellationPress(renderer)();
      await Promise.resolve();
    });
    expect(hoisted.chatComposer.draft).toEqual({ text: 'Next session prompt', files: [] });
    expect(readBubble(renderer, nextMessage.info.id)).toBeUndefined();
    expect(statusMessages(renderer)).toEqual([]);
    unmountScreen(renderer);
  });

  it('removes a busy row when the live queue becomes running', async () => {
    const message = queuedMessage();
    seedQueuedMessage(message);
    const request = Promise.withResolvers<{ dropped: boolean }>();
    currentManager.cancelQueuedMessage.mockReturnValue(request.promise);
    const renderer = mount();
    openDetails(renderer, message);
    const press = cancellationPress(renderer);
    act(() => {
      press();
    });
    currentManager.atoms.pendingMessages.value = new Map([
      [message.info.id, { status: 'running' }],
    ]);
    updateScreen(renderer);
    expect(cancellationRow(renderer)).toBeUndefined();
    expect(detailsProps(renderer).isCancelingQueued).toBe(false);
    await act(async () => {
      press();
      request.resolve({ dropped: false });
      await request.promise;
    });
    expect(currentManager.cancelQueuedMessage.mock.calls).toEqual([[message.info.id]]);
    expect(cancellationRow(renderer)).toBeUndefined();
    expect(readBubble(renderer, message.info.id)).toBeDefined();
    expect(statusMessages(renderer)).toEqual([failed]);
    expect(hoisted.chatComposer.draft).toEqual({ text: '', files: [] });
    unmountScreen(renderer);
  });

  it.each([false, true])(
    'clears both announcement inputs on retry without replay on dismissal, first dismissed=%s',
    async dismissed => {
      const message = queuedMessage();
      seedQueuedMessage(message);
      const first = Promise.withResolvers<{ dropped: boolean }>();
      const retry = Promise.withResolvers<{ dropped: boolean }>();
      currentManager.cancelQueuedMessage
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(retry.promise);
      const renderer = mount();
      openDetails(renderer, message);
      act(() => {
        cancellationPress(renderer)();
      });
      if (dismissed) {
        closeDetails(renderer);
      }
      await act(async () => {
        first.reject(new Error('offline'));
        await Promise.resolve();
      });
      expect(statusMessages(renderer)).toEqual([failed]);
      expect(hoisted.announce.mock.calls).toEqual([[failed]]);
      if (dismissed) {
        openDetails(renderer, message);
      }
      act(() => {
        cancellationPress(renderer)();
      });
      expect(statusMessages(renderer)).toEqual([]);
      expect(detailsProps(renderer).cancelQueuedFeedback).toBeNull();
      expect(findByType(renderer, Text).map(node => node.props.children)).not.toContain(failed);
      expect(hoisted.announce.mock.calls).toEqual([[failed]]);
      await act(async () => {
        retry.reject(new Error('offline'));
        await Promise.resolve();
      });
      expect(statusMessages(renderer)).toEqual([failed]);
      expect(hoisted.announce.mock.calls).toEqual([[failed], [failed]]);
      closeDetails(renderer);
      expect(statusMessages(renderer)).toEqual([]);
      expect(hoisted.announce.mock.calls).toEqual([[failed], [failed]]);
      openDetails(renderer, message);
      expect(detailsProps(renderer).cancelQueuedFeedback).toBeNull();
      expect(hoisted.announce).toHaveBeenCalledTimes(2);
      unmountScreen(renderer);
    }
  );

  it('announces identical immediate failures once per attempt despite React batching', async () => {
    const message = queuedMessage();
    seedQueuedMessage(message);
    currentManager.cancelQueuedMessage.mockResolvedValue({ dropped: false });
    const renderer = mount();
    openDetails(renderer, message);
    await act(async () => {
      cancellationPress(renderer)();
      await Promise.resolve();
    });
    await act(async () => {
      cancellationPress(renderer)();
      await Promise.resolve();
    });
    expect(statusMessages(renderer)).toEqual([failed]);
    expect(hoisted.announce.mock.calls).toEqual([[failed], [failed]]);
    unmountScreen(renderer);
  });

  it.each(['success', 'false', 'rejection'])(
    'announces one outer %s outcome when dismissed while pending',
    async outcome => {
      const message = queuedMessage();
      seedQueuedMessage(message);
      const request = Promise.withResolvers<{ dropped: boolean }>();
      currentManager.cancelQueuedMessage.mockReturnValue(request.promise);
      const renderer = mount();
      openDetails(renderer, message);
      act(() => {
        cancellationPress(renderer)();
      });
      closeDetails(renderer);
      expect(statusMessages(renderer)).toEqual([]);
      await act(async () => {
        if (outcome === 'rejection') {
          request.reject(new Error('offline'));
        } else {
          request.resolve({ dropped: outcome === 'success' });
        }
        await Promise.resolve();
      });
      expect(detailsProps(renderer).visible).toBe(false);
      expect(detailsProps(renderer).cancelQueuedFeedback).toBeNull();
      expect(statusMessages(renderer)).toEqual(outcome === 'success' ? [] : [failed]);
      expect(hoisted.announce.mock.calls).toEqual([[outcome === 'success' ? restored : failed]]);
      expect(hoisted.chatComposer.draft.text).toBe(outcome === 'success' ? 'Queued prompt' : '');
      closeDetails(renderer);
      expect(hoisted.announce).toHaveBeenCalledTimes(1);
      unmountScreen(renderer);
    }
  );

  it.each([
    { outcome: 'success', firstFeedback: restored },
    { outcome: 'false', firstFeedback: failed },
    { outcome: 'rejection', firstFeedback: failed },
    { outcome: 'upgrade', firstFeedback: 'agentChat.session.cancelQueuedUpgradeRequired' },
  ])(
    'keeps the selected failure when A completes later with $outcome',
    async ({ outcome, firstFeedback }) => {
      const first = queuedMessage([TEXT_PART, FILE_PART]);
      const second = {
        ...queuedMessage([{ ...TEXT_PART, text: 'Second prompt' }]),
        info: { ...first.info, id: 'msg-queued-2' },
      };
      currentManager.atoms.messagesList.value = [first, second];
      currentManager.atoms.pendingMessages.value = new Map(
        [first, second].map(message => [message.info.id, { status: 'queued' }])
      );
      const firstRequest = Promise.withResolvers<{ dropped: boolean }>();
      const secondRequest = Promise.withResolvers<{ dropped: boolean }>();
      currentManager.cancelQueuedMessage
        .mockReturnValueOnce(firstRequest.promise)
        .mockReturnValueOnce(secondRequest.promise);
      const renderer = mount();
      openDetails(renderer, first);
      act(() => {
        cancellationPress(renderer)();
      });
      closeDetails(renderer);
      openDetails(renderer, second);
      act(() => {
        cancellationPress(renderer)();
      });
      await act(async () => {
        secondRequest.resolve({ dropped: false });
        await secondRequest.promise;
      });
      expect(detailsProps(renderer).cancelQueuedFeedback?.message).toBe(failed);
      expect(hoisted.announce.mock.calls).toEqual([[failed]]);
      await act(async () => {
        if (outcome === 'rejection' || outcome === 'upgrade') {
          firstRequest.reject(
            Object.assign(new Error(outcome), {
              code: outcome === 'upgrade' ? 'CLI_UPGRADE_REQUIRED' : 'SERVICE_UNAVAILABLE',
            })
          );
        } else {
          firstRequest.resolve({ dropped: outcome === 'success' });
        }
        await Promise.resolve();
      });
      expect(detailsProps(renderer).visible).toBe(true);
      expect(detailsProps(renderer).message?.info.id).toBe(second.info.id);
      expect(detailsProps(renderer).cancelQueuedFeedback?.message).toBe(failed);
      expect(
        renderer.root
          .findByType(MessageDetailsSheet)
          .findAll(node => node.type === Text && node.props.children === failed)
      ).toHaveLength(1);
      expect(detailsProps(renderer).canCancelQueued).toBe(outcome !== 'upgrade');
      expect(statusMessages(renderer)).toEqual(
        outcome === 'success' ? [failed] : [firstFeedback, failed]
      );
      expect(hoisted.announce.mock.calls).toEqual([[failed], [firstFeedback]]);
      expect(hoisted.chatComposer.draft).toEqual(
        outcome === 'success'
          ? { text: 'Queued prompt', files: [FILE_PART] }
          : { text: '', files: [] }
      );
      expect(readBubble(renderer, second.info.id)).toBeDefined();
      expect(bubbleProps(renderer, second.info.id).onRestoreQueued).toBeUndefined();
      expect(currentManager.cancelQueuedMessage.mock.calls).toEqual([
        [first.info.id],
        [second.info.id],
      ]);
      closeDetails(renderer);
      expect(statusMessages(renderer)).toEqual(outcome === 'success' ? [] : [firstFeedback]);
      expect(hoisted.announce.mock.calls).toEqual([[failed], [firstFeedback]]);
      unmountScreen(renderer);
    }
  );

  it('keeps another message’s sheet failure on request start and clears only the matching retry', async () => {
    const first = queuedMessage();
    const second = { ...first, info: { ...first.info, id: 'msg-queued-2' } };
    currentManager.atoms.messagesList.value = [first, second];
    currentManager.atoms.pendingMessages.value = new Map(
      [first, second].map(message => [message.info.id, { status: 'queued' }])
    );
    const firstRequest = Promise.withResolvers<{ dropped: boolean }>();
    const secondRequest = Promise.withResolvers<{ dropped: boolean }>();
    const secondRetry = Promise.withResolvers<{ dropped: boolean }>();
    currentManager.cancelQueuedMessage
      .mockReturnValueOnce(secondRequest.promise)
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRetry.promise);
    const renderer = mount();
    openDetails(renderer, first);
    const staleFirstPress = cancellationPress(renderer);
    openDetails(renderer, second);
    act(() => {
      cancellationPress(renderer)();
    });
    await act(async () => {
      secondRequest.resolve({ dropped: false });
      await secondRequest.promise;
    });
    expect(statusMessages(renderer)).toEqual([failed]);
    act(() => {
      staleFirstPress();
    });
    expect(detailsProps(renderer).message?.info.id).toBe(second.info.id);
    expect(detailsProps(renderer).cancelQueuedFeedback?.message).toBe(failed);
    expect(statusMessages(renderer)).toEqual([failed]);
    expect(hoisted.announce.mock.calls).toEqual([[failed]]);
    await act(async () => {
      firstRequest.resolve({ dropped: false });
      await firstRequest.promise;
    });
    expect(statusMessages(renderer)).toEqual([failed, failed]);
    expect(hoisted.announce.mock.calls).toEqual([[failed], [failed]]);
    act(() => {
      cancellationPress(renderer)();
    });
    expect(detailsProps(renderer).cancelQueuedFeedback).toBeNull();
    expect(statusMessages(renderer)).toEqual([failed]);
    expect(hoisted.announce.mock.calls).toEqual([[failed], [failed]]);
    await act(async () => {
      secondRetry.resolve({ dropped: false });
      await secondRetry.promise;
    });
    expect(detailsProps(renderer).cancelQueuedFeedback?.message).toBe(failed);
    expect(statusMessages(renderer)).toEqual([failed, failed]);
    expect(hoisted.announce.mock.calls).toEqual([[failed], [failed], [failed]]);
    expect(hoisted.chatComposer.draft).toEqual({ text: '', files: [] });
    expect(readBubble(renderer, first.info.id)).toBeDefined();
    expect(readBubble(renderer, second.info.id)).toBeDefined();
    closeDetails(renderer);
    expect(statusMessages(renderer)).toEqual([failed]);
    expect(hoisted.announce.mock.calls).toEqual([[failed], [failed], [failed]]);
    unmountScreen(renderer);
  });

  it.each([true, false])(
    'binds an old request outcome to its message, dropped=%s',
    async dropped => {
      const first = queuedMessage();
      const second = {
        ...queuedMessage([{ ...TEXT_PART, text: 'Second prompt' }]),
        info: { ...first.info, id: 'msg-queued-2' },
      };
      currentManager.atoms.messagesList.value = [first, second];
      currentManager.atoms.pendingMessages.value = new Map(
        [first, second].map(message => [message.info.id, { status: 'queued' }])
      );
      const request = Promise.withResolvers<{ dropped: boolean }>();
      currentManager.cancelQueuedMessage.mockReturnValue(request.promise);
      const renderer = mount();
      openDetails(renderer, first);
      act(() => {
        cancellationPress(renderer)();
      });
      openDetails(renderer, second);
      await act(async () => {
        request.resolve({ dropped });
        await request.promise;
      });
      expect(currentManager.cancelQueuedMessage.mock.calls).toEqual([[first.info.id]]);
      expect(detailsProps(renderer).visible).toBe(true);
      expect(detailsProps(renderer).message?.info.id).toBe(second.info.id);
      expect(detailsProps(renderer).canCancelQueued).toBe(true);
      expect(detailsProps(renderer).cancelQueuedFeedback).toBeNull();
      expect(statusMessages(renderer)).toEqual(dropped ? [] : [failed]);
      expect(hoisted.announce.mock.calls).toEqual([[dropped ? restored : failed]]);
      expect(hoisted.chatComposer.draft.text).toBe(dropped ? 'Queued prompt' : '');
      unmountScreen(renderer);
    }
  );
});

describe('SessionDetailContent send failure', () => {
  it('throws without putting the prompt back itself (the composer owns the restore)', async () => {
    currentManager.send.mockResolvedValue(false);

    const renderer = mount();
    const onSend = hoisted.chatComposer.lastProps?.onSend;
    expect(onSend).toBeInstanceOf(Function);

    await act(async () => {
      await expect(onSend?.('prompt text', {})).rejects.toThrow('Failed to send message');
    });

    // The session layer must not restore the prompt itself — that would
    // duplicate the composer's own empty-composer restore.
    expect(hoisted.chatComposer.control.setText).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });
});

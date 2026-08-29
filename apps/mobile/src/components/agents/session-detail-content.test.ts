/* eslint-disable max-lines -- the session test renders the full SessionDetailContent and mocks its RN/expo/SDK surface, so the wiring is long. */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/app/(app)/agent-chat/[session-id].mounted.test.tsx. */
/* eslint-disable require-await, @typescript-eslint/require-await -- mock factories settle without await because they resolve immediately */
import { createElement, type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type KiloSessionId, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import type * as ReactI18next from 'react-i18next';

import { type SessionTranscriptItem } from '@/components/agents/session-transcript';
import {
  resolveSendAttachmentKind,
  shouldRefuseSilentAttachmentDrop,
} from '@/components/agents/session-detail-send-attachment';

// The composer and session-list mocks are the only two sub-components the
// suite drives; everything else is a string host element so the tree renders
// without pulling in the real native/navigation surface.
const hoisted = vi.hoisted(() => ({
  managerRef: { current: null as unknown },
  chatComposer: {
    control: {
      hasContent: vi.fn(() => false),
      setText: vi.fn(),
      restoreAttachments: vi.fn(),
    },
    lastProps: null as null | {
      onSend?: (text: string, options?: Record<string, unknown>) => Promise<void> | void;
    },
  },
}));

// Mock every RN / Expo / SDK side-effect import that `mobile-session-manager.ts`
// and `session-detail-content.tsx` pull in transitively before loading either
// module.
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
  useTRPC: () => ({ organizations: { list: { queryOptions: () => ({}) } } }),
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
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useFocusEffect: vi.fn(),
  useIsFocused: () => true,
  useRouter: () => ({ replace: vi.fn(), canGoBack: () => true, back: vi.fn() }),
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
// Each atom carries its current value on `.value` so `useAtomValue` can read it
// without a real Jotai store. `useSetAtom` and `useStore` are inert.
vi.mock('jotai', () => ({
  useAtomValue: (atom: { value: unknown }) => atom.value,
  useSetAtom: () => vi.fn(),
  useStore: () => ({ get: vi.fn(), sub: vi.fn(() => vi.fn()) }),
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
    isTitleInteractive: true,
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
  collectEmptyChildSessionIds: () => [],
  countInFlightMessages: () => 0,
  hydrateEmptyChildSessions: vi.fn(),
  resolveRetryPrompt: () => null,
  retryMessageAndClear: vi.fn(),
  runConnectRepository: vi.fn(),
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
vi.mock('@/components/agents/message-details-sheet', () => ({
  MessageDetailsSheet: 'MessageDetailsSheet',
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
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'token' }) }));
const globalContext = vi.hoisted(() => ({
  organizationId: 'global-org',
  isLoaded: true,
  error: null,
  retry: vi.fn(),
  setOrganizationId: vi.fn(),
}));
vi.mock('@/lib/organization-context', () => ({ useOrganization: () => globalContext }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: [{ organizationId: 'org-a', organizationName: 'Session organization' }],
  }),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: 'AccessibleStatus',
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
  ChevronLeft: 'ChevronLeft',
  ChevronDown: 'ChevronDown',
  MessageSquare: 'MessageSquare',
}));

const { SessionDetailContent } = await import('@/components/agents/session-detail-content');

const SESSION_ID = 'sess-1' as KiloSessionId;

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
      pendingQuestions: { value: [] },
      pendingPermissions: { value: [] },
      totalCost: { value: null },
      childMessages: { value: () => new Map() },
      childSessionHydrationState: { value: () => ({ status: 'idle' }) },
      childSessionError: { value: () => null },
      pendingMessages: { value: new Map<string, { status: string }>() },
      activeSessionType: { value: null },
      remoteModelState: { value: { catalog: null, ownerConnectionId: null, protocol: 'v1' } },
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

const PERSONAL_DISPLAY_SCOPE = { organizationId: null, isResolved: true };

function mount(
  displayScope: Parameters<typeof SessionDetailContent>[0]['displayScope'] = PERSONAL_DISPLAY_SCOPE
): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionDetailContent, { sessionId: SESSION_ID, displayScope })
    );
  });
  if (!ref.current) {
    throw new Error('SessionDetailContent did not render');
  }
  return ref.current;
}

function findByType(
  renderer: TestRenderer.ReactTestRenderer,
  type: string
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(node => node.type === type);
}

/** Reads the MessageBubble element the current transcript renders for `messageId`. */
function readBubble(
  renderer: TestRenderer.ReactTestRenderer,
  messageId: string
): ReactElement | undefined {
  const lists = findByType(renderer, 'SessionMessageList');
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

beforeEach(() => {
  currentManager = makeManager();
  hoisted.managerRef.current = currentManager;
  hoisted.chatComposer.lastProps = null;
  hoisted.chatComposer.control.hasContent.mockReset().mockReturnValue(false);
  hoisted.chatComposer.control.setText.mockReset();
  hoisted.chatComposer.control.restoreAttachments.mockReset();
});

describe('resolveSendAttachmentKind', () => {
  it.each([
    { activeSessionType: 'cloud-agent' as const, supports: true, has: true, expected: 'cloud' },
    { activeSessionType: 'cloud-agent' as const, supports: false, has: true, expected: 'cloud' },
    { activeSessionType: 'remote' as const, supports: true, has: true, expected: 'remote-capable' },
    { activeSessionType: 'remote' as const, supports: false, has: true, expected: 'none' },
    { activeSessionType: 'read-only' as const, supports: true, has: true, expected: 'none' },
    { activeSessionType: null, supports: true, has: true, expected: 'none' },
    { activeSessionType: undefined, supports: true, has: true, expected: 'none' },
    { activeSessionType: 'cloud-agent' as const, supports: true, has: false, expected: 'none' },
    { activeSessionType: 'remote' as const, supports: true, has: false, expected: 'none' },
  ])(
    'returns $expected for sessionType=$activeSessionType, supports=$supports, has=$has',
    ({ activeSessionType, supports, has, expected }) => {
      expect(resolveSendAttachmentKind(activeSessionType, supports, has)).toBe(expected);
    }
  );
});

describe('shouldRefuseSilentAttachmentDrop', () => {
  it.each([
    { kind: 'none' as const, hasAttachments: true, expected: true },
    { kind: 'none' as const, hasAttachments: false, expected: false },
    { kind: 'cloud' as const, hasAttachments: true, expected: false },
    { kind: 'cloud' as const, hasAttachments: false, expected: false },
    { kind: 'remote-capable' as const, hasAttachments: true, expected: false },
    { kind: 'remote-capable' as const, hasAttachments: false, expected: false },
  ])(
    'returns $expected for kind=$kind, hasAttachments=$hasAttachments',
    ({ kind, hasAttachments, expected }) => {
      expect(shouldRefuseSilentAttachmentDrop(kind, hasAttachments)).toBe(expected);
    }
  );
});

describe('SessionDetailContent display scope', () => {
  it.each([
    { organizationId: null, isResolved: true, label: 'profile.personal' },
    { organizationId: 'org-a', isResolved: true, label: 'Session organization' },
    { organizationId: 'missing-org', isResolved: true, label: 'profile.organization' },
    { organizationId: null, isResolved: false, label: 'profile.selectAccount' },
  ])('renders a read-only $label and preserves header actions', state => {
    const renderer = mount({ organizationId: state.organizationId, isResolved: state.isResolved });
    const label = renderer.root.find(
      node => node.type === 'View' && node.props.accessibilityRole === 'text'
    );
    expect(label.props.accessibilityLabel).toBe(state.label);
    expect(label.props.accessibilityState).toEqual({ busy: !state.isResolved });
    const controls = findByType(renderer, 'Pressable');
    expect(
      controls.filter(node => node.props.accessibilityHint === 'profile.selectAccount')
    ).toHaveLength(0);
    expect(controls.map(node => node.props.accessibilityLabel)).toContain('screenHeader.goBack');
    expect(controls.map(node => node.props.accessibilityLabel)).toContain(
      'agentChat.session.renameAccessibility'
    );
    if (state.organizationId === 'missing-org') {
      expect(findByType(renderer, 'AccessibleStatus').map(node => node.props.message)).toContain(
        'organization.boundary.organizationUnavailable'
      );
    }
    expect(globalContext.organizationId).toBe('global-org');
    expect(globalContext.setOrganizationId).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });
});

describe('SessionDetailContent cancel/restore', () => {
  function seedQueuedMessage(message: StoredMessage = queuedMessage()): void {
    currentManager.atoms.messagesList.value = [message];
    currentManager.atoms.pendingMessages.value = new Map([[message.info.id, { status: 'queued' }]]);
  }

  it('keeps the Restore action after canceling a queued message while the composer is occupied', async () => {
    seedQueuedMessage();
    currentManager.cancelQueuedMessage.mockResolvedValue({ dropped: true });
    hoisted.chatComposer.control.hasContent.mockReturnValue(true);

    const renderer = mount();
    const onCancelQueued = bubbleProps(renderer, 'msg-queued-1').onCancelQueued as
      | ((message: StoredMessage) => Promise<void>)
      | undefined;
    expect(onCancelQueued).toBeInstanceOf(Function);

    await act(async () => {
      await onCancelQueued?.(queuedMessage());
    });

    // Occupied composer → the row must stay with a Restore action, not be
    // dropped out of the transcript.
    expect(bubbleProps(renderer, 'msg-queued-1').onRestoreQueued).toBeInstanceOf(Function);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the queued row and shows a failure status when cancel reports dropped=false', async () => {
    seedQueuedMessage();
    currentManager.cancelQueuedMessage.mockResolvedValue({ dropped: false });
    hoisted.chatComposer.control.hasContent.mockReturnValue(false);

    const renderer = mount();
    const onCancelQueued = bubbleProps(renderer, 'msg-queued-1').onCancelQueued as
      | ((message: StoredMessage) => Promise<void>)
      | undefined;
    expect(onCancelQueued).toBeInstanceOf(Function);

    await act(async () => {
      await onCancelQueued?.(queuedMessage());
    });

    // The queue did not drop the message: the row stays queued (still wired
    // for Cancel, no Restore) and the prompt is not restored into the composer.
    expect(bubbleProps(renderer, 'msg-queued-1').onCancelQueued).toBeInstanceOf(Function);
    expect(bubbleProps(renderer, 'msg-queued-1').onRestoreQueued).toBeUndefined();
    expect(hoisted.chatComposer.control.setText).not.toHaveBeenCalled();
    expect(hoisted.chatComposer.control.restoreAttachments).not.toHaveBeenCalled();

    const statuses = findByType(renderer, 'AccessibleStatus');
    const messages = statuses.map(instance => instance.props.message as string | null);
    expect(messages).toContain('agentChat.session.cancelQueuedFailed');

    act(() => {
      renderer.unmount();
    });
  });

  it('restores the prompt and file parts into an empty composer after cancel', async () => {
    const message = queuedMessage([TEXT_PART, FILE_PART]);
    seedQueuedMessage(message);
    currentManager.cancelQueuedMessage.mockResolvedValue({ dropped: true });
    hoisted.chatComposer.control.hasContent.mockReturnValue(false);

    const renderer = mount();
    const onCancelQueued = bubbleProps(renderer, 'msg-queued-1').onCancelQueued as
      | ((message: StoredMessage) => Promise<void>)
      | undefined;
    expect(onCancelQueued).toBeInstanceOf(Function);

    await act(async () => {
      await onCancelQueued?.(message);
    });

    expect(hoisted.chatComposer.control.setText).toHaveBeenCalledWith('Queued prompt');
    expect(hoisted.chatComposer.control.restoreAttachments).toHaveBeenCalledWith([FILE_PART]);
    // Empty composer → the row is dropped, so the transcript no longer renders it.
    expect(readBubble(renderer, 'msg-queued-1')).toBeUndefined();

    act(() => {
      renderer.unmount();
    });
  });

  it('shows the upgrade-required copy when cancel fails with CLI_UPGRADE_REQUIRED', async () => {
    seedQueuedMessage();
    currentManager.cancelQueuedMessage.mockRejectedValue(
      Object.assign(new Error('old cli'), { code: 'CLI_UPGRADE_REQUIRED' })
    );

    const renderer = mount();
    const onCancelQueued = bubbleProps(renderer, 'msg-queued-1').onCancelQueued as
      | ((message: StoredMessage) => Promise<void>)
      | undefined;
    expect(onCancelQueued).toBeInstanceOf(Function);

    await act(async () => {
      await onCancelQueued?.(queuedMessage());
    });

    const statuses = findByType(renderer, 'AccessibleStatus');
    const messages = statuses.map(instance => instance.props.message as string | null);
    expect(messages).toContain('agentChat.session.cancelQueuedUpgradeRequired');

    act(() => {
      renderer.unmount();
    });
  });
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

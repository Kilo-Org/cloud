/* eslint-disable max-lines -- Keep the detail trigger and real SDK request regressions with their shared screen fixture. */
import {
  type ComponentProps,
  createElement,
  type ElementType,
  Fragment,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createStore, Provider } from 'jotai';
import { QueryClientProvider } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { sessionResumeUrl } from '@kilocode/app-shared/universal-links';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { type Pressable } from 'react-native';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createSessionManager,
  createUserWebConnection,
  type KiloSessionId,
  type ReasoningPart,
  type SessionGoal,
  type SessionManager,
  type SessionSnapshotPageOutcome,
  type SessionStatusIndicator,
  type StandalonePermission,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import { kiloId, stubTextPart } from '@kilocode/cloud-agent-sdk/test-helpers';

import { ChildSessionSection } from '@/components/agents/child-session-section';
import { ChildSessionModelLabel } from '@/components/agents/child-session-model-label';
import { ChildSessionSheet } from '@/components/agents/child-session-sheet';
import { getTaskToolSessionId } from '@/components/agents/child-session-card-state';
import { MessageBubble } from '@/components/agents/message-bubble';
import { assistantMessage } from '@/components/agents/message-bubble-test-utils';
import {
  exitRemoteSessionWithFeedback,
  type RetryableExitFailure,
} from '@/components/agents/exit-remote-session-with-feedback';
import { RemoteSessionExitFailure } from '@/components/agents/remote-session-exit-failure';
import { PermissionCard } from '@/components/agents/permission-card';
import { setSessionAutoApproveEnabled } from '@/components/agents/session-auto-approve';
import {
  isSessionGoalCollapsed,
  setSessionGoalCollapsed,
} from '@/components/agents/session-goal-collapse';
import { SessionDetailContent } from '@/components/agents/session-detail-content';
import { SessionContextSheet } from '@/components/agents/session-context-sheet';
import { SessionGoalSection } from '@/components/agents/session-goal-section';
import { SessionSkeletonMessages } from '@/components/agents/session-detail-skeleton';
import { SESSION_SLOW_LOAD_MS } from '@/components/agents/session-slow-load';
import { SessionMessageList } from '@/components/agents/session-message-list';
import { WorkingIndicator } from '@/components/agents/working-indicator';
import {
  resolveSendAttachmentKind,
  shouldRefuseSilentAttachmentDrop,
} from '@/components/agents/session-detail-send-attachment';
import { ContextControl } from '@/components/context-control';
import { type Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { i18n } from '@/i18n';
import { captureEvent, SESSION_VIEWED_EVENT } from '@/lib/analytics/posthog';
import { recordLastOpenedSession } from '@/lib/last-opened-session';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const managerSlot = vi.hoisted(() => ({ current: null as SessionManager | null }));
const connectionHealth = vi.hoisted(() => ({
  isConnected: true,
  reconnectExhausted: false,
  retryConnection: vi.fn(),
}));
const hideThinking = vi.hoisted(() => ({ current: false, loaded: true }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/agents/session-provider', () => ({
  useSessionManager: () => {
    if (!managerSlot.current) {
      throw new Error('Missing test session manager');
    }
    return managerSlot.current;
  },
}));
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => connectionHealth.isConnected,
  useUserWebConnectionHealth: () => ({
    isConnected: connectionHealth.isConnected,
    reconnectExhausted: connectionHealth.reconnectExhausted,
  }),
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({ retryConnection: connectionHealth.retryConnection }),
}));

// Keep the actual detail/card/sheet/header callbacks and SDK. Replace native
// rendering and unrelated composer, account, model-picker, and router dependencies.
const navigationRoutes = vi.hoisted(() => ['session-detail']);
// The personal `agentProfiles.list` rows the header's active-profile chip
// reads; tests set it before mounting to drive the chip's presence.
const profileRowsState = vi.hoisted(() => ({
  personal: [] as unknown[],
  combined: {
    orgProfiles: [] as unknown[],
    personalProfiles: [] as unknown[],
    effectiveDefaultId: null as string | null,
  },
}));
const routerSetParams = vi.hoisted(() => vi.fn());
const handoffAdvertiserCalls = vi.hoisted(() => ({
  props: [] as { anchorMessageId?: string | null }[],
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
// The header's offline-banner reservation reads the committed connectivity
// hook; these states are online, and the hook module pulls NetInfo (unmocked
// in the pure project).
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useOfflineBannerState: () => false,
}));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  LinearTransition: { duration: () => ({}) },
  // The goal row's chevron rotation; the disclosure animation itself is
  // covered by session-goal-section.mounted.test.tsx.
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withTiming: (value: number) => value,
}));
const motionPolicy = vi.hoisted(() => ({ reducedMotion: false }));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({
    reducedMotion: motionPolicy.reducedMotion,
    scrollAnimated: !motionPolicy.reducedMotion,
  }),
  selectReducedMotionEntrance: <T>(_reducedMotion: boolean, entrance: T) => entrance,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 16 }),
}));
vi.mock('expo-router', () => ({
  useFocusEffect: vi.fn(),
  useIsFocused: () => true,
  useRouter: () => ({
    canGoBack: () => navigationRoutes.length > 1,
    back: () => {
      navigationRoutes.pop();
    },
    replace: (href: string) => {
      navigationRoutes.splice(-1, 1, href);
    },
    push: (href: string) => {
      navigationRoutes.push(href);
    },
    setParams: routerSetParams,
  }),
}));
// `useStackSafeReplace` owns the push + post-transition stack cleanup that keeps
// Android Fabric alive (KILO-APP-25); its own mechanics are covered in
// src/lib/navigation/stack-safe-replace.mounted.test.tsx. Here it stands in for
// the navigation call so these assertions stay about the resulting route list.
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({
    replace: (href: string) => {
      navigationRoutes.splice(-1, 1, href);
    },
  }),
}));
vi.mock('expo-keep-awake', () => ({ useKeepAwake: vi.fn() }));
const hapticsSelection = vi.hoisted(() => vi.fn());
vi.mock('expo-haptics', () => ({
  selectionAsync: hapticsSelection,
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Error: 'error', Success: 'success' },
}));
vi.mock('@/components/agents/mobile-session-manager', () => ({
  isCancelQueuedUpgradeRequired: vi.fn(),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  ChevronDown: 'ChevronDown',
  CircleDot: 'CircleDot',
  Clock: 'Clock',
  Link2: 'Link2',
  Loader2: 'Loader2',
  MessageSquare: 'MessageSquare',
  SlidersHorizontal: 'SlidersHorizontal',
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronLeft: 'ChevronLeft',
  DirectionalChevronRight: 'ChevronRight',
}));
vi.mock('@/components/ui/spinning-icon', () => ({ SpinningIcon: 'SpinningIcon' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/bubble', () => ({ Bubble: 'Bubble' }));
vi.mock('@/components/ui/blur-bar', () => ({ BlurBar: 'BlurBar' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/agents/part-detail-sheet-host', () => ({
  PartDetailSheetHost: 'PartDetailSheetHost',
}));
vi.mock('@/components/agents/tool-run-sheet-host', () => ({
  ToolRunSheetHost: 'ToolRunSheetHost',
}));
vi.mock('@/components/agents/tool-run-rows', () => ({
  CondensedToolRunRow: 'CondensedToolRunRow',
}));
vi.mock('@/components/agents/message-error-boundary', () => ({
  MessageErrorBoundary: 'MessageErrorBoundary',
}));
vi.mock('@/components/agents/message-details-sheet', () => ({
  MessageDetailsSheet: 'MessageDetailsSheet',
}));
vi.mock('@/components/agents/chat-composer', () => ({ ChatComposer: 'ChatComposer' }));
vi.mock('@/components/agents/model-selector', () => ({
  ModelPickerSelectionScopeProvider: 'ModelPickerSelectionScopeProvider',
}));
vi.mock('@/components/agents/permission-card', () => ({ PermissionCard: 'PermissionCard' }));
vi.mock('@/components/agents/question-card', () => ({ QuestionCard: 'QuestionCard' }));
vi.mock('@/components/agents/preparation-group', () => ({ PreparationGroup: 'PreparationGroup' }));
vi.mock('@/components/agents/context-usage-ring', () => ({
  ContextUsageRing: 'ContextUsageRing',
}));
// The real context sheet (rendered so the auto-approve row can be asserted)
// reaches `copySessionId`, which imports the native `expo-clipboard` module that
// cannot load in this DOM-free node suite. Mock the boundary, as the mounted
// context-sheet suite does. The session header's copy-link action reaches the
// same native module through the real chat-link copy path.
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/components/agents/session-row-actions', () => ({ copySessionId: vi.fn() }));
// The copy-link path reaches the browser helper; its native module cannot load here.
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
// The handoff advertiser owns the OS entry point (Head plus Android's launcher
// module) and has its own mounted suite; recording its props here proves the
// screen hands it the live position.
vi.mock('@/lib/session-handoff', () => ({
  SessionHandoffAdvertiser: (props: { anchorMessageId?: string | null }) => {
    handoffAdvertiserCalls.props.push(props);
    return null;
  },
}));
vi.mock('@/components/agents/session-pr-badge', () => ({ SessionPrBadge: 'SessionPrBadge' }));
vi.mock('@/components/agents/session-status-indicator', () => ({
  SessionStatusIndicator: 'SessionStatusIndicator',
}));
vi.mock('@/components/agents/session-detail-skeleton', () => ({
  SessionSkeletonMessages: 'SessionSkeletonMessages',
}));
vi.mock('@/components/agents/transcript-time-marker', () => ({
  TranscriptTimeMarker: 'TranscriptTimeMarker',
}));
vi.mock('@/components/agents/compaction-separator', () => ({
  CompactionSeparator: 'CompactionSeparator',
}));
vi.mock('@/components/agents/file-part-renderer', () => ({ FilePartRenderer: 'FilePartRenderer' }));
vi.mock('@/components/agents/reasoning-part-renderer', () => ({
  ReasoningPartRenderer: ({ text }: { text: string }) =>
    createElement('ReasoningPartRenderer', null, createElement('Text', null, text)),
}));
vi.mock('@/components/agents/text-part-renderer', () => ({
  TextPartRenderer: ({ text }: { text: string }) => createElement('Text', null, text),
}));
vi.mock('@/components/agents/chat-markdown-text', () => ({
  ChatMarkdownText: ({ value }: { value: string }) => createElement('Text', null, value),
}));
vi.mock('@/components/agents/tool-cards', () => ({ TaskToolCard: 'TaskToolCard' }));
vi.mock('@/components/agents/suggest-tool-card', () => ({ SuggestToolCard: 'SuggestToolCard' }));
vi.mock('@/components/agents/session-message-list', () => ({
  SessionMessageList: function MessageList<T>(props: ComponentProps<typeof SessionMessageList<T>>) {
    return createElement(
      'MessageList',
      null,
      props.items.map((item, index) =>
        createElement(
          Fragment,
          { key: props.keyExtractor(item) },
          props.renderItem({ item, index, target: 'Cell' })
        )
      ),
      props.ListFooterComponent as ReactNode
    );
  },
}));
vi.mock('@/components/kilo-chat/app-aware-keyboard-padding', () => ({
  AppAwareKeyboardPaddingView: 'AppAwareKeyboardPaddingView',
}));
vi.mock('@/components/kilo-chat/hooks/use-cli-session-presence', () => ({
  resolveLoadedCliSessionPresenceId: vi.fn(),
  useCliSessionPresence: vi.fn(),
}));
vi.mock('@/components/agents/create-and-navigate-agent-session', () => ({
  createAndNavigateAgentSession: vi.fn(),
}));
vi.mock('@/components/agents/exit-remote-session-with-feedback', () => ({
  exitRemoteSessionWithFeedback: vi.fn(),
}));
vi.mock('@/components/agents/restart-agent-session', () => ({ restartAgentSession: vi.fn() }));
vi.mock('@/components/agents/mobile-session-manager-helpers', () => ({
  buildRemoteAttachmentParts: vi.fn(),
}));
vi.mock('@/components/agents/use-message-copy', () => ({
  useMessageCopy: () => ({ copyMessage: vi.fn() }),
  performCopy: vi.fn(),
}));
vi.mock('@/components/agents/use-interaction-handlers', () => ({
  useInteractionHandlers: ({
    manager,
    activePermission,
  }: {
    manager: Pick<SessionManager, 'respondToPermission'>;
    activePermission: { requestId: string } | null;
  }) => ({
    isAnswering: false,
    isRespondingToPermission: false,
    questionSubmissionError: null,
    permissionSubmissionError: null,
    handleAnswerQuestion: vi.fn(),
    handleRejectQuestion: vi.fn(),
    // Mirrors the real hook's contract: reply "once" to the active permission
    // and report the transport outcome the auto-approve hook reacts to.
    handleRespondToPermission: async (response: 'once' | 'always' | 'reject') => {
      if (!activePermission) {
        return 'ok' as const;
      }
      await manager.respondToPermission(activePermission.requestId, response);
      return 'ok' as const;
    },
  }),
}));
vi.mock('@/components/agents/use-session-config-sync', () => ({
  useSessionConfigSync: () => ({ currentMode: 'code', currentModel: '', currentVariant: '' }),
}));
const openRenameModal = vi.hoisted(() => vi.fn());
vi.mock('@/components/agents/use-session-detail-rename', () => ({
  useSessionDetailRename: ({
    serverTitle,
    fallbackTitle,
  }: {
    serverTitle?: string;
    fallbackTitle: string;
  }) => ({
    title: serverTitle ?? fallbackTitle,
    isTitleInteractive: serverTitle !== undefined,
    openModal: openRenameModal,
  }),
}));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  MESSAGE_SENT_EVENT: 'sent',
  SESSION_VIEWED_EVENT: 'viewed',
}));
vi.mock('@/lib/a11y/announce', () => ({
  moveA11yFocus: () => false,
  announceForA11y: vi.fn(),
}));
// `test-user` by default; the last-opened test flips it to `undefined` to model
// the identity resolving after the session's first render.
const currentUserId = vi.hoisted(() => ({ value: 'test-user' as string | undefined }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: currentUserId.value, isLoading: false }),
}));
vi.mock('@/lib/last-opened-session', () => ({
  recordLastOpenedSession: vi.fn(),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: [], isLoading: false }),
}));
vi.mock('@/lib/hooks/use-model-preferences', () => ({
  useModelPreferences: () => ({ setLastSelected: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-persisted-agent-model', () => ({
  usePersistedAgentModel: () => ({ saveModel: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-reasoning-preference', () => ({
  useReasoningPreference: () => ({ defaultExpanded: false }),
}));
vi.mock('@/lib/hooks/use-hide-thinking-preference', () => ({
  useHideThinkingPreference: () => ({
    hideThinking: hideThinking.current,
    hasLoaded: hideThinking.loaded,
  }),
}));
vi.mock('@/lib/hooks/use-keep-screen-on-preference', () => ({
  useKeepScreenOnPreference: () => ({ keepScreenOn: false, hasLoaded: true }),
}));
const condensePreference = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/hooks/use-condense-tool-calls-preference', () => ({
  useCondenseToolCallsPreference: () => ({
    condenseToolCalls: condensePreference.value,
    hasLoaded: true,
    setCondenseToolCalls: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-session-model-options', () => ({
  useSessionModelOptions: () => ({ options: [], selectedValue: '', selectedVariant: '' }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/persist/drafts', () => ({ agentComposerDraftKey: (id: string) => id }));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ settled: true, value: null }),
}));
const organizations = vi.hoisted(() => [
  { organizationId: 'org-a', organizationName: 'Session organization' },
]);
vi.mock('@/lib/trpc', () => ({
  trpcClient: {},
  useTRPC: () => ({
    organizations: {
      list: {
        queryOptions: () => ({
          queryKey: ['organizations'],
          queryFn: () => organizations,
          initialData: organizations,
        }),
      },
    },
    // The session header's active-profile chip reads the context profiles; the
    // hoisted rows let a test resolve a default, and the empty default keeps
    // the chip absent so the existing header assertions hold.
    agentProfiles: {
      list: {
        queryOptions: () => ({
          queryKey: ['agentProfiles', 'list'],
          queryFn: () => profileRowsState.personal,
          initialData: profileRowsState.personal,
        }),
      },
      listCombined: {
        queryOptions: () => ({
          queryKey: ['agentProfiles', 'listCombined'],
          queryFn: () => profileRowsState.combined,
          initialData: profileRowsState.combined,
        }),
      },
    },
    // The real context sheet resolves the "running on" row from the connected
    // CLI instances; the row is inert here, so an empty instance list keeps the
    // sheet rendering without a network read.
    activeSessions: {
      listInstances: {
        queryOptions: () => ({
          queryKey: ['activeSessions', 'listInstances'],
          queryFn: () => ({ instances: [] }),
          initialData: { instances: [] },
        }),
      },
    },
  }),
}));
// Captured so the goal tests can open the action sheet and pick a control.
const showActionSheetWithOptions = vi.hoisted(() =>
  vi.fn<(options: Record<string, unknown>, callback: (index?: number) => void) => void>()
);
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions }),
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

const PERSONAL_DISPLAY_SCOPE = { organizationId: null, isResolved: true };
/**
 * Goal/type overrides for the goal-visibility tests. A module-level slot keeps
 * the shared `mountDetails` fixture at its existing three-parameter signature.
 */
let goalMountOptions: { goal?: SessionGoal; resolvedType?: 'read-only' | 'remote' } = {};
const ROOT_ID = kiloId('ses-root');
const NEXT_ROOT_ID = kiloId('ses-next-root');
const SELECTED_ID = kiloId('ses-selected');
const NESTED_ID = kiloId('ses-nested');
const CHILD_IDS = [
  SELECTED_ID,
  ...Array.from({ length: 23 }, (_, index) => kiloId(`ses-sibling-${index}`)),
];

function taskMessage(parentId: KiloSessionId, childIds: KiloSessionId[]): StoredMessage {
  const message = assistantMessage(`msg-${parentId}`);
  return {
    info: { ...message.info, sessionID: parentId },
    parts: childIds.map((childId, index): ToolPart => {
      const input = { description: `Task ${childId}`, subagent_type: 'Researcher' };
      const metadata = { sessionId: childId };
      let state: ToolPart['state'] = {
        status: 'completed',
        input,
        metadata,
        output: 'Done',
        title: 'Task',
        time: { start: 1, end: 2 },
      };
      if (index % 3 === 1) {
        state = { status: 'running', input, metadata, time: { start: 1 } };
      } else if (index % 3 === 2) {
        state = {
          status: 'error',
          input,
          metadata,
          error: 'Task failed',
          time: { start: 1, end: 2 },
        };
      }
      return {
        id: `part-${childId}`,
        sessionID: parentId,
        messageID: message.info.id,
        type: 'tool',
        tool: 'task',
        callID: `call-${childId}`,
        state,
      };
    }),
  };
}

function childMessage(sessionId: KiloSessionId, text: string): StoredMessage {
  const message = assistantMessage(`msg-${sessionId}`);
  return {
    info: { ...message.info, sessionID: sessionId },
    parts: [
      stubTextPart({
        id: `text-${sessionId}`,
        sessionID: sessionId,
        messageID: message.info.id,
        text,
      }),
    ],
  };
}

/** An assistant message of consecutive `read` tool parts that condense into one run. */
function toolRunMessage(
  sessionId: KiloSessionId,
  messageId: string,
  partIds: readonly string[]
): StoredMessage {
  const message = assistantMessage(messageId);
  message.info = { ...message.info, sessionID: sessionId };
  message.parts = partIds.map(
    (partId, index): ToolPart => ({
      id: partId,
      sessionID: sessionId,
      messageID: messageId,
      type: 'tool',
      callID: `call-${partId}`,
      tool: 'read',
      state: {
        status: 'completed',
        input: { filePath: `/repo/${partId}.ts` },
        output: '',
        title: 'read',
        metadata: {},
        time: { start: index, end: index + 1 },
      },
    })
  );
  return message;
}

function page(
  sessionId: KiloSessionId,
  messages: StoredMessage[],
  options: { goal?: SessionGoal; nextCursor?: string | null } = {}
): SessionSnapshotPageOutcome {
  return {
    kind: 'success',
    info: { id: sessionId, ...(options.goal ? { goal: options.goal } : {}) },
    messages,
    nextCursor: options.nextCursor ?? null,
    omittedItemCount: 0,
  };
}

// Set before `mountDetails` by the zero-render guard tests; the root page
// resolves with this cursor instead of the default `null`.
let rootPageNextCursor: string | null = null;

function messageLists(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(node => Object.is(node.type, 'MessageList'));
}

beforeEach(() => {
  navigationRoutes.splice(0, navigationRoutes.length, 'session-detail');
  profileRowsState.personal = [];
  profileRowsState.combined = { orgProfiles: [], personalProfiles: [], effectiveDefaultId: null };
  openRenameModal.mockClear();
  showActionSheetWithOptions.mockClear();
  hideThinking.current = false;
  hideThinking.loaded = true;
  goalMountOptions = {};
  globalContext.organizationId = 'global-org';
  globalContext.setOrganizationId.mockClear();
  rootPageNextCursor = null;
  condensePreference.value = false;
  currentUserId.value = 'test-user';
  connectionHealth.isConnected = true;
  connectionHealth.reconnectExhausted = false;
  connectionHealth.retryConnection.mockClear();
});

type MountDetailsOptions = {
  metadataReady?: Promise<undefined>;
  displayScope?: ComponentProps<typeof SessionDetailContent>['displayScope'];
  cachedRows?: StoredMessage[] | null;
  /** The route's `?at=` param the screen mounts with. */
  resumeAt?: string | null;
  sessionOrganizationId?: string;
};

async function mountDetails(
  rootMessages: StoredMessage[] | null = [taskMessage(ROOT_ID, CHILD_IDS)],
  options: MountDetailsOptions = {}
) {
  const {
    metadataReady,
    displayScope = PERSONAL_DISPLAY_SCOPE,
    cachedRows = null,
    resumeAt,
  } = options;
  const store = createStore();
  // `null` stalls the root page: the request never resolves, so the open never
  // receives first content (the endless-skeleton case).
  const rootPages = new Map<KiloSessionId, StoredMessage[]>(
    rootMessages === null ? [] : [[ROOT_ID, rootMessages]]
  );
  const requests: {
    id: KiloSessionId;
    response: ReturnType<typeof Promise.withResolvers<SessionSnapshotPageOutcome | null>>;
  }[] = [];
  const connection = createUserWebConnection({
    websocketUrl: 'wss://example.test',
    getAuthToken: vi.fn(),
  });
  const manager = createSessionManager({
    store,
    userWebConnection: connection,
    resolveSession: async id => {
      await Promise.resolve();
      if (goalMountOptions.resolvedType === 'remote') {
        return { type: 'remote', kiloSessionId: id };
      }
      return { type: 'read-only', kiloSessionId: id };
    },
    getTicket: vi.fn(),
    fetchSnapshot: vi.fn(),
    fetchSnapshotPage: async id => {
      const response = Promise.withResolvers<SessionSnapshotPageOutcome | null>();
      requests.push({ id, response });
      const messages = rootPages.get(id);
      if (messages) {
        // Serve only the first request per id; a re-fetch (e.g. the older-page
        // load a zero-render transcript triggers) stays pending for `respond`.
        rootPages.delete(id);
        response.resolve(
          page(id, messages, { goal: goalMountOptions.goal, nextCursor: rootPageNextCursor })
        );
      }
      const outcome = await response.promise;
      return outcome;
    },
    readCachedSnapshotPage: cachedRows
      ? vi.fn().mockResolvedValue({
          info: { id: ROOT_ID },
          messages: cachedRows,
          nextCursor: null,
          omittedItemCount: 0,
        })
      : undefined,
    api: {
      send: vi.fn(),
      interrupt: vi.fn(),
      answer: vi.fn(),
      reject: vi.fn(),
      respondToPermission: vi.fn(),
    },
    prepare: vi.fn(),
    initiate: vi.fn(),
    fetchSession: async id => {
      await metadataReady;
      return {
        kiloSessionId: id,
        cloudAgentSessionId: null,
        title: `Root ${id}`,
        organizationId: options.sessionOrganizationId ?? null,
        gitUrl: null,
        gitBranch: null,
        mode: null,
        model: null,
        variant: null,
        repository: null,
        isInitiated: true,
        needsLegacyPrepare: false,
        isPreparingAsync: false,
        prompt: null,
        initialMessageId: null,
        associatedPr: null,
      };
    },
  });
  managerSlot.current = manager;
  onTestFinished(() => {
    manager.destroy();
    connection.destroy();
  });
  let currentRootId: KiloSessionId = ROOT_ID;
  const element = (id: KiloSessionId, at: string | null | undefined = resumeAt) =>
    createElement(
      Provider,
      { store },
      createElement(SessionDetailContent, {
        key: id,
        sessionId: id,
        displayScope,
        ...(at === undefined ? {} : { resumeAt: at }),
      })
    );
  const view = await renderWithProviders(element(ROOT_ID));
  onTestFinished(view.unmount);
  const requestFor = (id: KiloSessionId) => {
    const request = requests.findLast(candidate => candidate.id === id);
    if (!request) {
      throw new Error(`No page request for ${id}`);
    }
    return request.response;
  };
  return {
    ...view,
    manager,
    store,
    rootPages,
    requestedIds: () => requests.map(request => request.id),
    respond: async (id: KiloSessionId, messages: StoredMessage[]) => {
      await act(async () => {
        requestFor(id).resolve(page(id, messages, { goal: goalMountOptions.goal }));
        await Promise.resolve();
      });
    },
    respondOutcome: async (id: KiloSessionId, outcome: SessionSnapshotPageOutcome) => {
      await act(async () => {
        requestFor(id).resolve(outcome);
        await Promise.resolve();
      });
    },
    fail: async (id: KiloSessionId, error: unknown) => {
      await act(async () => {
        requestFor(id).reject(error);
        await Promise.resolve();
      });
    },
    switchRoot: async (id: KiloSessionId) => {
      await act(async () => {
        currentRootId = id;
        view.renderer.update(
          createElement(QueryClientProvider, { client: view.queryClient }, element(id))
        );
        await Promise.resolve();
      });
    },
    /**
     * Deliver a new route `at` to the already-mounted screen (the `withAnchor`
     * dedupe path updates params instead of remounting the route).
     */
    updateResumeAt: async (next: string | null) => {
      await act(async () => {
        view.renderer.update(
          createElement(
            QueryClientProvider,
            { client: view.queryClient },
            element(currentRootId, next)
          )
        );
        await Promise.resolve();
      });
    },
  };
}

function cardFor(renderer: ReactTestRenderer, sessionId: KiloSessionId): ReactTestInstance {
  const card = renderer.root.findAllByType(ChildSessionSection).find(node => {
    const props = node.props as ComponentProps<typeof ChildSessionSection>;
    return getTaskToolSessionId(props.part) === sessionId;
  });
  if (!card) {
    throw new Error(`No card for ${sessionId}`);
  }
  return card;
}

function pressCard(renderer: ReactTestRenderer, sessionId: KiloSessionId) {
  const { onPress } = cardFor(renderer, sessionId).findByProps({ accessibilityRole: 'button' })
    .props as { onPress: () => void };
  act(() => {
    onPress();
  });
}

function sheetProps(renderer: ReactTestRenderer) {
  return renderer.root.findByType(ChildSessionSheet).props as ComponentProps<
    typeof ChildSessionSheet
  >;
}

function renderedText(node: ReactTestInstance) {
  return node
    .findAll(child => typeof child.type === 'string' && (child.type as string) === 'Text')
    .flatMap(child => child.children.filter(value => typeof value === 'string'))
    .join('\n');
}

/**
 * Page text outside the context sheet. The sheet stays mounted (invisible) as
 * soon as usage is known, so a "nothing renders on the page" assertion must not
 * count the sheet's own rows.
 */
function renderedTextOutsideSheet(root: ReactTestInstance): string {
  const sheetNodes = new Set<ReactTestInstance>(
    root.findAllByType(SessionContextSheet).flatMap(sheet => sheet.findAll(() => true))
  );
  return root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .filter(node => !sheetNodes.has(node))
    .flatMap(node => node.children.filter((value): value is string => typeof value === 'string'))
    .join('\n');
}

function reasoningRenderers(renderer: ReactTestRenderer) {
  return renderer.root.findAll(node => Object.is(node.type, 'ReasoningPartRenderer'));
}

function pressHeaderBack(renderer: ReactTestRenderer) {
  const { onPress } = renderer.root.findByProps({ accessibilityLabel: 'Go back' }).props as {
    onPress: () => void;
  };
  act(onPress);
}

describe('SessionDetailContent display scope', () => {
  it.each([
    { organizationId: null, isResolved: true, label: i18n.t('common.personal') },
    { organizationId: 'org-a', isResolved: true, label: 'Session organization' },
    { organizationId: 'missing-org', isResolved: true, label: i18n.t('common.organization') },
    { organizationId: null, isResolved: false, label: i18n.t('profile.selectAccount') },
  ])('omits the $label context label and preserves header actions', async state => {
    const { renderer } = await mountDetails([], {
      displayScope: {
        organizationId: state.organizationId,
        isResolved: state.isResolved,
      },
    });
    const header = renderer.root.findByType(ScreenHeader);
    expect(header.findByProps({ accessibilityRole: 'header' }).props).toMatchObject({
      numberOfLines: 2,
      ellipsizeMode: 'tail',
    });
    expect(header.findByProps({ accessibilityRole: 'header' }).parent?.props.className).toContain(
      'min-h-14'
    );
    expect(header.props.context).toBeUndefined();
    expect(header.findAllByType(ContextControl)).toHaveLength(0);
    expect(
      header.findAll(node => node.props.accessibilityHint === i18n.t('profile.selectAccount'))
    ).toHaveLength(0);
    expect(header.findByProps({ accessibilityLabel: i18n.t('common.goBack') })).toBeDefined();
    const { onPress } = header.findByProps({
      accessibilityLabel: i18n.t('agentChat.session.renameAccessibility', {
        title: `Root ${ROOT_ID}`,
      }),
    }).props as { onPress: () => void };
    act(onPress);
    expect(openRenameModal).toHaveBeenCalledOnce();
    pressHeaderBack(renderer);
    expect(navigationRoutes).toEqual(['/(app)/(tabs)/(2_agents)']);
    expect(globalContext.organizationId).toBe('global-org');
    expect(globalContext.setOrganizationId).not.toHaveBeenCalled();
  });
});

describe('session detail active-profile indicator', () => {
  const PROFILE_ROW = {
    id: 'p1',
    name: 'Production',
    description: null,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    varCount: 2,
    commandCount: 1,
    mcpServerCount: 1,
    skillCount: 1,
    agentCount: 1,
    kiloCommandCount: 1,
  };

  function findChip(renderer: ReactTestRenderer) {
    return renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith(i18n.t('agentChat.newSession.profileActive'))
    );
  }

  it('shows the chip for the session context effective default and opens its editor', async () => {
    profileRowsState.personal = [PROFILE_ROW];
    const { renderer } = await mountDetails();

    const [chip] = findChip(renderer);
    if (chip === undefined) {
      throw new Error('the active-profile chip did not render');
    }
    expect(chip.props.accessibilityLabel).toContain('Production');
    act(() => {
      (chip.props.onPress as () => void)();
    });
    expect(navigationRoutes.at(-1)).toBe('/(app)/(tabs)/(3_profile)/profiles/p1');
  });

  it.each(['user', 'organization'] as const)(
    'opens a %s default from an organization session in its owner scope',
    async ownerType => {
      const profile = { ...PROFILE_ROW, ownerType };
      profileRowsState.combined = {
        personalProfiles: ownerType === 'user' ? [profile] : [],
        orgProfiles: ownerType === 'organization' ? [profile] : [],
        effectiveDefaultId: profile.id,
      };
      const { renderer } = await mountDetails([], {
        sessionOrganizationId: 'org-a',
        displayScope: { organizationId: 'org-a', isResolved: true },
      });
      const [chip] = findChip(renderer);
      if (!chip) {
        throw new Error('the active-profile chip did not render');
      }
      act(() => {
        (chip.props.onPress as () => void)();
      });
      expect(navigationRoutes.at(-1)).toBe(
        `/(app)/(tabs)/(3_profile)/profiles/p1${ownerType === 'organization' ? '?organizationId=org-a' : ''}`
      );
    }
  );

  it('renders no chip when the context has no profiles', async () => {
    const { renderer } = await mountDetails();

    expect(findChip(renderer)).toHaveLength(0);
  });
});

describe('session detail status placement', () => {
  it.each(['progress', 'info'] as const)(
    'centers a %s status without transcript rows',
    async type => {
      const view = await mountDetails([]);
      act(() => {
        view.store.set<SessionStatusIndicator | null, [SessionStatusIndicator | null], unknown>(
          view.manager.atoms.statusIndicator,
          {
            type,
            message: 'Session status',
            timestamp: 0,
          }
        );
      });
      const centered = view.renderer.root.findAll(node => Object.is(node.type, 'CenteredState'));
      expect(centered).toHaveLength(1);
      expect(
        centered[0]?.findAll(node => Object.is(node.type, 'SessionStatusIndicator'))
      ).toHaveLength(1);
      expect(view.renderer.root.findAllByType(EmptyState)).toHaveLength(0);
    }
  );
});

describe('session detail slow load', () => {
  it('swaps the endless skeleton for taking-longer copy and a working Retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const view = await mountDetails(null);
      expect(view.renderer.root.findAllByType(SessionSkeletonMessages)).toHaveLength(1);
      expect(renderedText(view.renderer.root)).not.toContain(i18n.t('common.takingLonger'));

      await act(async () => {
        vi.advanceTimersByTime(SESSION_SLOW_LOAD_MS);
        await Promise.resolve();
      });

      expect(view.renderer.root.findAllByType(SessionSkeletonMessages)).toHaveLength(0);
      expect(renderedText(view.renderer.root)).toContain(i18n.t('common.takingLonger'));
      const retry = view.renderer.root.find(
        node =>
          Object.is(node.type, 'Button') && node.props.accessibilityLabel === i18n.t('common.retry')
      );
      const switchSession = vi.spyOn(view.manager, 'switchSession');
      act(() => {
        (retry.props.onPress as () => void)();
      });
      expect(switchSession).toHaveBeenCalledWith(ROOT_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a terminal error ahead of the slow state', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const view = await mountDetails(null);
      await act(async () => {
        vi.advanceTimersByTime(SESSION_SLOW_LOAD_MS);
        await Promise.resolve();
      });
      expect(renderedText(view.renderer.root)).toContain(i18n.t('common.takingLonger'));

      act(() => {
        view.store.set<string | null, [string | null], unknown>(
          view.manager.atoms.error,
          'fetch failed'
        );
      });

      const error = view.renderer.root.findByType(QueryError).props as ComponentProps<
        typeof QueryError
      >;
      expect(error.title).toBe(i18n.t('agentChat.session.couldNotLoadThisSession'));
      expect(renderedText(view.renderer.root)).not.toContain(i18n.t('common.takingLonger'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('acknowledges a slow-state Retry tap with a disabled spinner until content lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const view = await mountDetails(null);
      await act(async () => {
        vi.advanceTimersByTime(SESSION_SLOW_LOAD_MS);
        await Promise.resolve();
      });
      const findRetry = () =>
        view.renderer.root.find(
          node =>
            Object.is(node.type, 'Button') &&
            node.props.accessibilityLabel === i18n.t('common.retry')
        );
      const before = findRetry();
      expect(before.props.loading).toBe(false);

      act(() => {
        (before.props.onPress as () => void)();
      });
      // The tap is acknowledged immediately: the control shows its retrying
      // (loading + disabled) state before any content or error arrives.
      expect(findRetry().props.loading).toBe(true);

      // Let the retry's open settle through metadata + resolve so the fresh
      // transport's page request is the newest one, then answer it.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await view.respond(ROOT_ID, [childMessage(ROOT_ID, 'recovered row')]);
      await act(async () => {
        vi.advanceTimersByTime(0);
        await Promise.resolve();
      });
      // Content ends the acknowledgment: the slow card is gone and the
      // transcript paints.
      expect(renderedText(view.renderer.root)).not.toContain(i18n.t('common.takingLonger'));
      expect(renderedText(view.renderer.root)).toContain('recovered row');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands the Retry action back when the retried open also stalls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const view = await mountDetails(null);
      await act(async () => {
        vi.advanceTimersByTime(SESSION_SLOW_LOAD_MS);
        await Promise.resolve();
      });
      const findRetry = () =>
        view.renderer.root.find(
          node =>
            Object.is(node.type, 'Button') &&
            node.props.accessibilityLabel === i18n.t('common.retry')
        );
      act(() => {
        (findRetry().props.onPress as () => void)();
      });
      expect(findRetry().props.loading).toBe(true);

      // The retried open stalls again: no content and no error arrive. The
      // acknowledgment is bounded, so after one more threshold the button is
      // usable again instead of spinning in its disabled state forever.
      await act(async () => {
        vi.advanceTimersByTime(SESSION_SLOW_LOAD_MS);
        await Promise.resolve();
      });
      expect(findRetry().props.loading).toBe(false);
      expect(renderedText(view.renderer.root)).toContain(i18n.t('common.takingLonger'));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('session detail cached metadata refresh', () => {
  it('paints cached rows and offers a refresh Retry when the metadata read fails', async () => {
    const metadata = Promise.withResolvers<undefined>();
    const cachedRows = [childMessage(ROOT_ID, 'cached root row')];
    const view = await mountDetails(cachedRows, { metadataReady: metadata.promise, cachedRows });

    // The persisted transcript paints before the metadata read settles: no
    // skeleton, and the rows are on screen.
    expect(view.renderer.root.findAllByType(SessionSkeletonMessages)).toHaveLength(0);
    expect(renderedText(view.renderer.root)).toContain('cached root row');

    await act(async () => {
      metadata.reject(new Error('offline'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // A retryable metadata failure keeps the rows mounted and repoints the
    // connection status at a metadata refresh Retry instead of blanking them.
    expect(renderedText(view.renderer.root)).toContain('cached root row');
    expect(view.renderer.root.findAllByType(SessionSkeletonMessages)).toHaveLength(0);
    // The connection status has no row under the header any more: with the
    // context sheet closed, no connection copy renders on the page.
    const pageText = renderedTextOutsideSheet(view.renderer.root);
    expect(pageText).not.toContain(i18n.t('agentChat.sessionConnection.connecting'));
    expect(pageText).not.toContain(i18n.t('agentChat.sessionConnection.reconnecting'));
    expect(pageText).not.toContain(i18n.t('agentChat.sessionConnection.connectionLost'));
  });

  it('shows Connection lost in the sheet and retries the socket when reconnects are exhausted', async () => {
    connectionHealth.isConnected = false;
    connectionHealth.reconnectExhausted = true;
    const view = await mountDetails([]);
    act(() => {
      view.store.set(view.manager.atoms.activeSessionType, 'remote');
      view.store.set(view.manager.atoms.isReadOnly, false);
    });

    const metrics = view.renderer.root.findByProps({ testID: 'session-context-metrics' });
    act(() => {
      (metrics.props.onPress as () => void)();
    });

    const sheet = view.renderer.root.findByType(SessionContextSheet);
    expect(sheet.props.connectionDisplay).toBe('lost');
    expect(renderedText(view.renderer.root)).toContain(
      i18n.t('agentChat.sessionConnection.connectionLost')
    );

    const retry = view.renderer.root.findByProps({
      testID: 'session-context-sheet-connection-retry',
    });
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(connectionHealth.retryConnection).toHaveBeenCalledTimes(1);
  });

  it('routes the Connection lost Retry to the metadata refresh when the transcript is cached', async () => {
    const metadata = Promise.withResolvers<undefined>();
    const cachedRows = [childMessage(ROOT_ID, 'cached root row')];
    const view = await mountDetails(cachedRows, { metadataReady: metadata.promise, cachedRows });
    const switchSession = vi.spyOn(view.manager, 'switchSession').mockResolvedValue(undefined);

    await act(async () => {
      metadata.reject(new Error('offline'));
      await Promise.resolve();
      await Promise.resolve();
    });

    const metrics = view.renderer.root.findByProps({ testID: 'session-context-metrics' });
    act(() => {
      (metrics.props.onPress as () => void)();
    });

    const sheet = view.renderer.root.findByType(SessionContextSheet);
    expect(sheet.props.connectionDisplay).toBe('lost');
    const retry = view.renderer.root.findByProps({
      testID: 'session-context-sheet-connection-retry',
    });
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(switchSession).toHaveBeenCalledTimes(1);
    expect(connectionHealth.retryConnection).not.toHaveBeenCalled();
  });
});

describe('session detail connection latch', () => {
  it('reads Connecting, not Reconnecting, when the app-wide leg is up but the session transport never came up', async () => {
    goalMountOptions = { resolvedType: 'remote' };
    connectionHealth.isConnected = false;
    const view = await mountDetails([]);
    // The app-wide user-web leg comes up while the remote agent reports
    // disconnected: the session's own transport has still never been up, so the
    // latch must not inherit the unrelated user-web leg and claim a reconnect.
    act(() => {
      connectionHealth.isConnected = true;
      view.store.set(view.manager.atoms.activeSessionType, 'remote');
      view.store.set(view.manager.atoms.isReadOnly, false);
      view.store.set(view.manager.atoms.agentStatus, { type: 'disconnected' });
    });

    const metrics = view.renderer.root.findByProps({ testID: 'session-context-metrics' });
    act(() => {
      (metrics.props.onPress as () => void)();
    });

    const sheet = view.renderer.root.findByType(SessionContextSheet);
    expect(sheet.props.connectionDisplay).toBe('connecting');
  });

  it('reads Connecting, not Reconnecting, while a cached first load still refreshes its metadata', async () => {
    const metadata = Promise.withResolvers<undefined>();
    const cachedRows = [childMessage(ROOT_ID, 'cached root row')];
    const view = await mountDetails(cachedRows, { metadataReady: metadata.promise, cachedRows });

    // The cached transcript paints while the session type and metadata are
    // still resolving, and the app-wide user-web leg is already up. The leg is
    // not this session's transport yet, so it must not latch the session as
    // ever connected: the first load reads "Connecting…", not "Reconnecting…".
    expect(renderedText(view.renderer.root)).toContain('cached root row');
    const metrics = view.renderer.root.findByProps({ testID: 'session-context-metrics' });
    act(() => {
      (metrics.props.onPress as () => void)();
    });

    const sheet = view.renderer.root.findByType(SessionContextSheet);
    expect(sheet.props.connectionDisplay).toBe('connecting');
  });

  it('still reads Reconnecting after a live session transport drops', async () => {
    goalMountOptions = { resolvedType: 'remote' };
    const view = await mountDetails([]);
    // The session's own transport comes up: the latch commits.
    act(() => {
      view.store.set(view.manager.atoms.activeSessionType, 'remote');
      view.store.set(view.manager.atoms.isReadOnly, false);
    });
    // Then it drops. The committed latch is what separates this from a first
    // load, so the sheet reads "Reconnecting…".
    act(() => {
      connectionHealth.isConnected = false;
    });

    const metrics = view.renderer.root.findByProps({ testID: 'session-context-metrics' });
    act(() => {
      (metrics.props.onPress as () => void)();
    });

    const sheet = view.renderer.root.findByType(SessionContextSheet);
    expect(sheet.props.connectionDisplay).toBe('reconnecting');
  });
});

describe('session detail bottom strip', () => {
  it('keeps the home-indicator strip full-bleed (pure background, no side padding)', async () => {
    const { renderer } = await mountDetails([]);
    const strips = renderer.root.findAll(node => Object.is(node.type, 'BlurBar'));
    expect(strips).toHaveLength(1);
    // The spacer pads only the bottom inset: it hosts no controls, so it
    // stays full-bleed in landscape while the composer content carries the
    // sensor side insets.
    const spacer = strips[0]?.findAll(node => Object.is(node.type, 'View'))[0];
    expect(spacer).toBeDefined();
    const spacerStyle = spacer?.props.style as { height: number } | undefined;
    expect(spacerStyle).toEqual({ height: 16 });
    expect(Object.keys(spacerStyle ?? {})).toEqual(['height']);
  });
});

describe('session detail per-session auto-approve', () => {
  // The in-memory toggle store is module-global; clear this session so a
  // preceding test cannot leave auto-approve on for the next one.
  beforeEach(() => {
    setSessionAutoApproveEnabled(ROOT_ID, false);
  });

  function makeSessionAnswerable(view: Awaited<ReturnType<typeof mountDetails>>) {
    act(() => {
      view.store.set(view.manager.atoms.activeSessionType, 'remote');
      view.store.set(view.manager.atoms.isReadOnly, false);
      view.store.set(view.manager.atoms.canSend, true);
      view.store.set<StandalonePermission | null, [StandalonePermission | null], unknown>(
        view.manager.atoms.activePermission,
        {
          requestId: 'perm-1',
          permission: 'bash',
          patterns: [],
          metadata: {},
          always: [],
        }
      );
    });
  }

  function composerNode(renderer: ReactTestRenderer): ReactTestInstance {
    const found = renderer.root.findAll(node => Object.is(node.type, 'ChatComposer'));
    expect(found).toHaveLength(1);
    const composer = found[0];
    if (!composer) {
      throw new Error('composer was not rendered');
    }
    return composer;
  }

  // The composer's own wrapper is the only node that carries the
  // `hidden` + `accessibilityElementsHidden` gating in the detail body.
  function composerWrapper(renderer: ReactTestRenderer): ReactTestInstance {
    const wrapper = composerNode(renderer).parent?.parent;
    if (!wrapper) {
      throw new Error('composer wrapper was not rendered');
    }
    return wrapper;
  }

  it('opens the header sheet before usage arrives and resolves the pending permission through its toggle', async () => {
    const view = await mountDetails([]);
    makeSessionAnswerable(view);
    const respondToPermission = vi
      .spyOn(view.manager, 'respondToPermission')
      .mockResolvedValue(undefined);
    expect(view.renderer.root.findAllByType(PermissionCard)).toHaveLength(1);

    const metrics = view.renderer.root.findByProps({ testID: 'session-context-metrics' });
    const metricsProps = metrics.props as { accessibilityRole: string; onPress: () => void };
    expect(metricsProps.accessibilityRole).toBe('button');
    act(() => {
      metricsProps.onPress();
    });
    const contextSheet = view.renderer.root.findByType(SessionContextSheet);
    expect(contextSheet.props.visible).toBe(true);
    expect(contextSheet.props.info).toBeUndefined();
    const toggle = view.renderer.root.findByProps({ testID: 'session-auto-approve-switch' });
    const { onValueChange } = toggle.props as { onValueChange: (enabled: boolean) => void };
    act(() => {
      onValueChange(true);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(respondToPermission).toHaveBeenCalledWith('perm-1', 'once');
    expect(view.renderer.root.findAllByType(PermissionCard)).toHaveLength(0);
    // One cross-platform selection haptic fires per toggle commit.
    expect(hapticsSelection).toHaveBeenCalledTimes(1);

    act(() => {
      onValueChange(false);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.renderer.root.findAllByType(PermissionCard)).toHaveLength(1);
    expect(respondToPermission).toHaveBeenCalledTimes(1);
    expect(hapticsSelection).toHaveBeenCalledTimes(2);
  });

  it('opens the header sheet while an answerable session is still loading', async () => {
    const view = await mountDetails([]);
    act(() => {
      view.store.set(view.manager.atoms.activeSessionType, 'remote');
      view.store.set(view.manager.atoms.isReadOnly, false);
      // No message has landed yet: the header control is the only way to the
      // session's permission settings, so it must still register a tap.
      view.store.set(view.manager.atoms.isLoading, true);
    });

    const metrics = view.renderer.root.findByProps({ testID: 'session-context-metrics' });
    const metricsProps = metrics.props as {
      accessibilityRole?: string;
      onPress?: () => void;
    };
    expect(metricsProps.accessibilityRole).toBe('button');
    act(() => {
      metricsProps.onPress?.();
    });
    const contextSheet = view.renderer.root.findByType(SessionContextSheet);
    expect(contextSheet.props.visible).toBe(true);
    expect(view.renderer.root.findByProps({ testID: 'session-auto-approve-switch' })).toBeDefined();
  });

  it('opens the header sheet with usable settings after a failed open left the transport unresolved', async () => {
    const view = await mountDetails([]);
    act(() => {
      // A failed session open leaves the transport unresolved and puts the
      // screen on its terminal error. The settings still live behind the
      // header control, so it must open the sheet instead of going dead.
      view.store.set<
        'cloud-agent' | 'read-only' | 'remote' | null,
        ['cloud-agent' | 'read-only' | 'remote' | null],
        unknown
      >(view.manager.atoms.activeSessionType, null);
      view.store.set<boolean, [boolean], unknown>(view.manager.atoms.isReadOnly, false);
      view.store.set(view.manager.atoms.isLoading, false);
      view.store.set<string | null, [string | null], unknown>(
        view.manager.atoms.error,
        'connect ECONNREFUSED 127.0.0.1:12000'
      );
    });

    const metrics = view.renderer.root.findByProps({ testID: 'session-context-metrics' });
    const metricsProps = metrics.props as {
      accessibilityRole?: string;
      onPress?: () => void;
    };
    expect(metricsProps.accessibilityRole).toBe('button');
    act(() => {
      metricsProps.onPress?.();
    });
    const contextSheet = view.renderer.root.findByType(SessionContextSheet);
    expect(contextSheet.props.visible).toBe(true);
    const toggle = view.renderer.root.findByProps({ testID: 'session-auto-approve-switch' });
    expect((toggle.props as { disabled?: boolean }).disabled).toBe(false);
  });

  it('keeps the composer mounted, visible, and enabled while the auto-reply is in flight', async () => {
    const view = await mountDetails([]);
    makeSessionAnswerable(view);
    // With the card actually rendered, the wrapper is gated out as before.
    expect(composerWrapper(view.renderer).props.accessibilityElementsHidden).toBe(true);

    // Hold the reply open so the assertion runs mid-round-trip, not after it.
    const reply = Promise.withResolvers<undefined>();
    const respondToPermission = vi
      .spyOn(view.manager, 'respondToPermission')
      .mockReturnValue(reply.promise);
    act(() => {
      setSessionAutoApproveEnabled(ROOT_ID, true);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(respondToPermission).toHaveBeenCalledWith('perm-1', 'once');

    // The card is suppressed, so nothing on screen blocks the input: the
    // composer must stay visible and enabled for the whole round trip.
    expect(view.renderer.root.findAllByType(PermissionCard)).toHaveLength(0);
    const wrapper = composerWrapper(view.renderer);
    expect(wrapper.props.className ?? '').not.toContain('hidden');
    expect(wrapper.props.accessibilityElementsHidden).toBe(false);
    expect(composerNode(view.renderer).props.disabled).toBe(false);

    await act(async () => {
      reply.resolve(undefined);
      await Promise.resolve();
    });
  });

  it('shows the card while the toggle is off without replying', async () => {
    const view = await mountDetails([]);
    makeSessionAnswerable(view);
    const respondToPermission = vi
      .spyOn(view.manager, 'respondToPermission')
      .mockResolvedValue(undefined);

    await act(async () => {
      await Promise.resolve();
    });

    expect(view.renderer.root.findAllByType(PermissionCard)).toHaveLength(1);
    expect(respondToPermission).not.toHaveBeenCalled();
  });
});

describe.each([true, false])('session detail return with history=%s', hasHistory => {
  beforeEach(() => {
    if (hasHistory) {
      navigationRoutes.unshift('previous-screen');
    }
  });

  it.each(['loaded after child dismissal', 'empty'] as const)('leaves %s content', async state => {
    const view = await mountDetails(state === 'empty' ? [] : undefined);
    if (state === 'empty') {
      expect(view.renderer.root.findByType(EmptyState).props).toMatchObject({
        title: i18n.t('agentChat.session.emptyTitle'),
      });
    } else {
      pressCard(view.renderer, SELECTED_ID);
      await view.respond(SELECTED_ID, [childMessage(SELECTED_ID, 'Selected child row')]);
      expect(renderedText(view.renderer.root.findByType(ChildSessionSheet))).toContain(
        'Selected child row'
      );
      act(() => {
        sheetProps(view.renderer).onClose();
      });
      act(() => {
        sheetProps(view.renderer).onDismiss?.();
      });
      expect(view.renderer.root.findAllByType(ChildSessionSheet)).toHaveLength(0);
      expect(renderedText(cardFor(view.renderer, SELECTED_ID))).toContain('Task ses-selected');
    }

    pressHeaderBack(view.renderer);
    expect(navigationRoutes).toEqual(
      hasHistory ? ['previous-screen'] : ['/(app)/(tabs)/(2_agents)']
    );
  });

  it.each([
    { state: 'pending metadata', code: undefined },
    { state: 'retryable metadata failure', code: 'INTERNAL_SERVER_ERROR' },
    { state: 'terminal access denial', code: 'UNAUTHORIZED' },
  ] as const)('leaves $state without changing its feedback', async ({ code }) => {
    const metadata = Promise.withResolvers<undefined>();
    const view = await mountDetails([], { metadataReady: metadata.promise });
    expect(view.renderer.root.findAllByType(SessionSkeletonMessages)).toHaveLength(1);
    if (code) {
      await act(async () => {
        metadata.reject({ data: { code } });
        await Promise.resolve();
      });
      const error = view.renderer.root.findByType(QueryError).props as ComponentProps<
        typeof QueryError
      >;
      expect(
        view.renderer.root.findAll(node => Object.is(node.type, 'CenteredState'))
      ).toHaveLength(1);
      expect(error.placement).toBe('top');
      expect(error.variant).toBe(code === 'UNAUTHORIZED' ? 'permission' : 'server');
      expect(Boolean(error.onRetry)).toBe(code !== 'UNAUTHORIZED');
      expect(renderedText(view.renderer.root)).toContain('Back to sessions');
      expect(renderedText(view.renderer.root)).toContain('Copy');
    }

    const header = view.renderer.root.findByType(ScreenHeader);
    expect(header.findByProps({ accessibilityRole: 'header' }).props).toMatchObject({
      numberOfLines: 2,
      ellipsizeMode: 'tail',
    });
    expect(header.findByProps({ accessibilityRole: 'header' }).parent?.props.className).toContain(
      'min-h-14'
    );
    pressHeaderBack(view.renderer);
    expect(navigationRoutes).toEqual(
      hasHistory ? ['previous-screen'] : ['/(app)/(tabs)/(2_agents)']
    );
  });
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

// These tests run in the existing detail suite with the DOM-free renderer.
// Request order and rendered state are deterministic; native paint timing is not.
describe('child transcript requests', () => {
  it.each([
    {
      sessionId: SELECTED_ID,
      status: 'completed',
      text: 'Researcher\nTask ses-selected\ncompleted',
      textRows: 3,
      activity: null,
    },
    {
      sessionId: kiloId('ses-sibling-0'),
      status: 'running',
      text: 'Researcher\nTask ses-sibling-0\nThinking\nrunning',
      textRows: 4,
      activity: 'Thinking',
    },
    {
      sessionId: kiloId('ses-sibling-1'),
      status: 'error',
      text: 'Researcher\nTask ses-sibling-1\nerror',
      textRows: 3,
      activity: null,
    },
  ] as const)(
    'renders the $status card without fetching a child transcript for labels',
    async ({ sessionId, status, text, textRows, activity }) => {
      const view = await mountDetails();
      const card = cardFor(view.renderer, sessionId);
      const button = card.findByProps({ accessibilityRole: 'button' }).props as ComponentProps<
        typeof Pressable
      >;

      expect(view.renderer.root.findAllByType(ChildSessionSection)).toHaveLength(24);
      expect(renderedText(card)).toBe(text);
      expect(card.findAll(node => (node.type as string) === 'Text')).toHaveLength(textRows);
      expect(button).toMatchObject({
        disabled: false,
        accessibilityState: { disabled: false },
        accessibilityHint: i18n.t('agentChat.childSession.openHint'),
      });
      expect(button.accessibilityLabel).toContain('Researcher');
      expect(button.accessibilityLabel).toContain(`Task ${sessionId}`);
      expect(button.accessibilityLabel).toContain(status);
      expect(button.accessibilityLabel?.includes('Waiting for activity')).toBe(false);
      if (activity) {
        expect(button.accessibilityLabel).toContain(activity);
      }
      expect(view.renderer.root.findAllByType(ChildSessionModelLabel)).toHaveLength(0);
      expect(view.requestedIds()).toEqual([ROOT_ID]);
    }
  );

  it.each([
    [SELECTED_ID, NESTED_ID, 'completed'],
    [kiloId('ses-sibling-0'), kiloId('ses-nested-sibling'), 'running'],
    [kiloId('ses-sibling-1'), kiloId('ses-nested-failed'), 'error'],
  ] as const)(
    'opens %s and its nested sheet immediately without requesting siblings',
    async (selectedId, nestedId, status) => {
      const isRunning = status === 'running';
      const view = await mountDetails();
      pressCard(view.renderer, selectedId);
      pressCard(view.renderer, selectedId);

      expect(sheetProps(view.renderer)).toMatchObject({
        visible: true,
        sessionId: selectedId,
        title: `Task ${selectedId}`,
        hydrationState: { status: 'loading' },
      });
      expect(view.requestedIds()).toEqual([ROOT_ID, selectedId]);

      const selected = taskMessage(selectedId, [
        NESTED_ID,
        kiloId('ses-nested-sibling'),
        kiloId('ses-nested-failed'),
      ]);
      selected.parts.push(...childMessage(selectedId, 'Selected child row').parts);
      await view.respond(selectedId, [selected]);
      expect(renderedText(view.renderer.root.findByType(ChildSessionSheet))).toContain(
        'Selected child row'
      );
      const selectedCard = cardFor(view.renderer, selectedId);
      expect(renderedText(selectedCard)).toContain(`Task ${selectedId}`);
      expect(renderedText(selectedCard).includes('Writing response')).toBe(isRunning);
      const selectedButton = selectedCard.findByProps({ accessibilityRole: 'button' })
        .props as ComponentProps<typeof Pressable>;
      expect(selectedButton.accessibilityLabel?.includes('Writing response')).toBe(isRunning);
      expect(selectedCard.findAllByType(ChildSessionModelLabel)).toHaveLength(1);
      const nestedCard = cardFor(view.renderer, nestedId);
      expect(renderedText(nestedCard)).toBe(
        `Researcher\nTask ${nestedId}${isRunning ? '\nThinking' : ''}\n${status}`
      );
      expect(nestedCard.findAll(node => (node.type as string) === 'Text')).toHaveLength(
        isRunning ? 4 : 3
      );
      const nestedButton = nestedCard.findByProps({ accessibilityRole: 'button' })
        .props as ComponentProps<typeof Pressable>;
      expect(nestedButton).toMatchObject({
        disabled: false,
        accessibilityState: { disabled: false },
        accessibilityHint: i18n.t('agentChat.childSession.openHint'),
      });
      expect(nestedButton.accessibilityLabel).toContain(`Task ${nestedId}`);
      expect(nestedButton.accessibilityLabel).toContain(status);
      expect(nestedButton.accessibilityLabel?.includes('Waiting for activity')).toBe(false);
      if (isRunning) {
        expect(nestedButton.accessibilityLabel).toContain('Thinking');
      }
      expect(view.requestedIds()).toEqual([ROOT_ID, selectedId]);

      pressCard(view.renderer, nestedId);
      expect(sheetProps(view.renderer)).toMatchObject({
        visible: true,
        sessionId: nestedId,
        title: `Task ${nestedId}`,
        hydrationState: { status: 'loading' },
      });
      expect(view.requestedIds()).toEqual([ROOT_ID, selectedId, nestedId]);
      await view.respond(nestedId, [childMessage(nestedId, 'Nested child row')]);
      expect(renderedText(view.renderer.root.findByType(ChildSessionSheet))).toContain(
        'Nested child row'
      );
      expect(renderedText(view.renderer.root.findByType(ChildSessionSheet))).not.toContain(
        'Selected child row'
      );

      pressCard(view.renderer, selectedId);
      expect(renderedText(view.renderer.root.findByType(ChildSessionSheet))).toContain(
        'Selected child row'
      );
      const hydratedNestedCard = cardFor(view.renderer, nestedId);
      expect(renderedText(hydratedNestedCard)).toContain(`Task ${nestedId}`);
      expect(renderedText(hydratedNestedCard).includes('Writing response')).toBe(isRunning);
      expect(hydratedNestedCard.findAllByType(ChildSessionModelLabel)).toHaveLength(1);
      const hydratedNestedButton = hydratedNestedCard.findByProps({ accessibilityRole: 'button' })
        .props as ComponentProps<typeof Pressable>;
      expect(hydratedNestedButton.accessibilityLabel?.includes('Writing response')).toBe(isRunning);
      expect(view.requestedIds()).toEqual([ROOT_ID, selectedId, nestedId]);
    }
  );

  it('keeps metadata after a retryable failure and retries only on explicit Retry', async () => {
    const view = await mountDetails();
    pressCard(view.renderer, SELECTED_ID);
    await view.fail(SELECTED_ID, new Error('fetch failed'));

    const errorProps = view.renderer.root.findByType(QueryError).props as ComponentProps<
      typeof QueryError
    >;
    expect(errorProps.message).toBe('Connection lost. Please retry in a moment.');
    expect(renderedText(cardFor(view.renderer, SELECTED_ID))).toContain('Task ses-selected');
    expect(view.requestedIds()).toEqual([ROOT_ID, SELECTED_ID]);

    act(() => {
      errorProps.onRetry?.();
      errorProps.onRetry?.();
    });
    expect(sheetProps(view.renderer).hydrationState.status).toBe('loading');
    expect(view.requestedIds()).toEqual([ROOT_ID, SELECTED_ID, SELECTED_ID]);
    await view.respond(SELECTED_ID, [childMessage(SELECTED_ID, 'Recovered child row')]);
    expect(renderedText(view.renderer.root.findByType(ChildSessionSheet))).toContain(
      'Recovered child row'
    );
    expect(view.renderer.root.findAllByType(QueryError)).toHaveLength(0);
  });

  it('preserves access-error copy and dismissal without automatic retry', async () => {
    const view = await mountDetails();
    pressCard(view.renderer, SELECTED_ID);
    await view.fail(SELECTED_ID, { data: { code: 'FORBIDDEN' } });

    const errorProps = view.renderer.root.findByType(QueryError).props as ComponentProps<
      typeof QueryError
    >;
    expect(errorProps.message).toBe('You are not authorized to use the Cloud Agent.');
    expect(view.requestedIds()).toEqual([ROOT_ID, SELECTED_ID]);
    act(() => {
      sheetProps(view.renderer).onClose();
    });
    expect(sheetProps(view.renderer).visible).toBe(false);
    act(() => {
      sheetProps(view.renderer).onDismiss?.();
    });
    expect(view.renderer.root.findAllByType(ChildSessionSheet)).toHaveLength(0);
    expect(renderedText(cardFor(view.renderer, SELECTED_ID))).toContain('Task ses-selected');
    expect(view.renderer.root.findAllByType(ChildSessionSection)).toHaveLength(24);
  });

  it.each(['failure', 'success'] as const)(
    'does not publish or retry old child work after a root change and late %s',
    async outcome => {
      const view = await mountDetails();
      pressCard(view.renderer, SELECTED_ID);
      view.rootPages.set(NEXT_ROOT_ID, [taskMessage(NEXT_ROOT_ID, [kiloId('ses-next-child')])]);
      await view.switchRoot(NEXT_ROOT_ID);
      await (outcome === 'failure'
        ? view.fail(SELECTED_ID, new Error('fetch failed'))
        : view.respond(SELECTED_ID, [childMessage(SELECTED_ID, 'Old scope row')]));

      expect(view.requestedIds()).toEqual([ROOT_ID, SELECTED_ID, NEXT_ROOT_ID]);
      expect(view.store.get(view.manager.atoms.childMessages)(SELECTED_ID)).toEqual([]);
      expect(view.renderer.root.findAllByType(ChildSessionSheet)).toHaveLength(0);
      expect(renderedText(view.renderer.root)).toContain('Task ses-next-child');
      expect(renderedText(view.renderer.root)).not.toContain('Old scope row');
      expect(renderedText(view.renderer.root)).not.toContain('Task ses-selected');
    }
  );

  it('shows confirmed empty history without fetching it again for labels or reopening', async () => {
    const view = await mountDetails();
    pressCard(view.renderer, SELECTED_ID);
    expect(view.renderer.root.findByType(EmptyState).props).toMatchObject({
      title: i18n.t('agentChat.childSessionSheet.loading'),
    });
    await view.respond(SELECTED_ID, []);
    expect(view.renderer.root.findByType(EmptyState).props).toMatchObject({
      title: i18n.t('agentChat.childSessionSheet.noMessages'),
    });

    act(() => {
      sheetProps(view.renderer).onClose();
    });
    act(() => {
      sheetProps(view.renderer).onDismiss?.();
    });
    pressCard(view.renderer, SELECTED_ID);
    expect(sheetProps(view.renderer)).toMatchObject({
      visible: true,
      hydrationState: { status: 'ready' },
    });
    expect(view.renderer.root.findByType(EmptyState).props).toMatchObject({
      title: i18n.t('agentChat.childSessionSheet.noMessages'),
    });
    expect(view.requestedIds()).toEqual([ROOT_ID, SELECTED_ID]);
    expect(cardFor(view.renderer, SELECTED_ID).findAllByType(ChildSessionModelLabel)).toHaveLength(
      0
    );
  });

  it('renders no child card or sheet when the root has no children', async () => {
    const view = await mountDetails([childMessage(ROOT_ID, 'Root-only row')]);
    expect(renderedText(view.renderer.root)).toContain('Root-only row');
    expect(view.renderer.root.findAllByType(ChildSessionSection)).toHaveLength(0);
    expect(view.renderer.root.findAllByType(ChildSessionSheet)).toHaveLength(0);
    expect(view.requestedIds()).toEqual([ROOT_ID]);
  });
});

describe('session detail zero-render transcript guard (mobile-app e2-open)', () => {
  function blankAssistantMessage(id: string): StoredMessage {
    const message = assistantMessage(id);
    return { info: { ...message.info, sessionID: ROOT_ID }, parts: [] };
  }

  it('shows the empty state instead of a zero-item list when no stored message renders', async () => {
    const view = await mountDetails([blankAssistantMessage('msg-blank')]);
    expect(messageLists(view.renderer)).toHaveLength(0);
    expect(view.renderer.root.findByType(EmptyState).props).toMatchObject({
      title: i18n.t('agentChat.session.emptyTitle'),
    });
    expect(view.requestedIds()).toEqual([ROOT_ID]);
  });

  it('pages older messages into the reserved skeleton while a zero-render transcript has a cursor', async () => {
    rootPageNextCursor = 'older-cursor';
    const view = await mountDetails([blankAssistantMessage('msg-blank')]);
    // Old defect: the blank zero-item list mounted here (no loading, no empty
    // state). New: the skeleton holds the space and the host pages older rows.
    expect(messageLists(view.renderer)).toHaveLength(0);
    expect(view.renderer.root.findAllByType(SessionSkeletonMessages)).toHaveLength(1);
    expect(view.requestedIds()).toEqual([ROOT_ID, ROOT_ID]);
    // The older page renders nothing either: the cursor ends, the defined
    // empty state takes over.
    await view.respond(ROOT_ID, [blankAssistantMessage('msg-blank-older')]);
    expect(view.renderer.root.findAllByType(SessionSkeletonMessages)).toHaveLength(0);
    expect(messageLists(view.renderer)).toHaveLength(0);
    expect(view.renderer.root.findByType(EmptyState).props).toMatchObject({
      title: i18n.t('agentChat.session.emptyTitle'),
    });
  });

  it('mounts the pagination Retry when a zero-render transcript fails to page older history', async () => {
    rootPageNextCursor = 'older-cursor';
    const view = await mountDetails([blankAssistantMessage('msg-blank')]);
    expect(view.requestedIds()).toEqual([ROOT_ID, ROOT_ID]);
    // Old defect: the retryable failure collapsed into the action-less empty
    // state. New: the body keeps the empty title but carries a working Retry.
    await view.fail(ROOT_ID, new Error('fetch failed'));
    expect(view.renderer.root.findAllByType(SessionSkeletonMessages)).toHaveLength(0);
    expect(messageLists(view.renderer)).toHaveLength(0);
    const empty = view.renderer.root.findByType(EmptyState);
    expect(empty.props).toMatchObject({
      title: i18n.t('agentChat.session.emptyTitle'),
    });
    // The action mounts on the EmptyState (the component is a test stub, so
    // the Retry button is inspected through the prop element).
    const action = (empty.props.action as ReactElement<ComponentProps<typeof Button>>).props;
    expect(action.accessibilityLabel).toBe(i18n.t('common.retry'));
    expect(action.accessibilityHint).toBe(i18n.t('agentChat.olderMessages.retryHint'));
    await act(async () => {
      (action.onPress as () => void)();
      await Promise.resolve();
    });
    // Retry reissues the older-page load through the manager.
    expect(view.requestedIds()).toEqual([ROOT_ID, ROOT_ID, ROOT_ID]);
  });

  it('keeps the action-less empty state when the zero-render transcript pages into a terminal outcome', async () => {
    rootPageNextCursor = 'older-cursor';
    const view = await mountDetails([blankAssistantMessage('msg-blank')]);
    await view.respondOutcome(ROOT_ID, { kind: 'invalid_data' });
    expect(messageLists(view.renderer)).toHaveLength(0);
    const empty = view.renderer.root.findByType(EmptyState);
    expect(empty.props).toMatchObject({
      title: i18n.t('agentChat.session.emptyTitle'),
    });
    expect(empty.props.action).toBeUndefined();
  });
});

describe('SessionDetailContent condensed tool runs', () => {
  it('wraps the condensed run row in MessageErrorBoundary like the per-part path', async () => {
    condensePreference.value = true;
    const view = await mountDetails([toolRunMessage(ROOT_ID, 'm-tool-run', ['t1', 't2'])]);

    const runRows = view.renderer.root.findAll(node => Object.is(node.type, 'CondensedToolRunRow'));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.parent?.type).toBe('MessageErrorBoundary');
  });
});

describe('session detail exit retry row', () => {
  it('drops the row when a retry fails with a non-retryable SDK message', async () => {
    const failureHandlers: {
      retryable?: (failure: RetryableExitFailure) => void;
      nonRetryable?: () => void;
    } = {};
    vi.mocked(exitRemoteSessionWithFeedback).mockImplementation(async input => {
      failureHandlers.retryable = input.onRetryableFailure;
      failureHandlers.nonRetryable = input.onNonRetryableFailure;
      input.onRetryableFailure?.({ message: 'connection reset', retry: vi.fn() });
      await Promise.resolve();
    });

    const view = await mountDetails([]);
    const composer = view.renderer.root.find(node => Object.is(node.type, 'ChatComposer'));
    const onExitSession = composer.props.onExitSession as (
      onAccepted: () => void,
      lock: { current: boolean },
      settleVoiceInput: () => Promise<boolean>
    ) => Promise<void>;

    await act(async () => {
      await onExitSession(vi.fn<() => void>(), { current: false }, async () => {
        await Promise.resolve();
        return true;
      });
    });
    expect(view.renderer.root.findAllByType(RemoteSessionExitFailure)).toHaveLength(1);

    // A retry that lands on a permanent SDK error must release the durable row
    // instead of leaving a stale message and a retry that can never succeed.
    act(() => {
      failureHandlers.nonRetryable?.();
    });
    expect(view.renderer.root.findAllByType(RemoteSessionExitFailure)).toHaveLength(0);
  });
});

describe('hide thinking preference', () => {
  function partMessage(id: string, parts: StoredMessage['parts']): StoredMessage {
    return { info: { ...assistantMessage(id).info, sessionID: ROOT_ID }, parts };
  }

  function reasoningPart(id: string, messageID: string): ReasoningPart {
    return {
      id,
      sessionID: ROOT_ID,
      messageID,
      type: 'reasoning',
      text: 'hidden chain of thought',
      time: { start: 1, end: 2 },
    };
  }

  function reasoningAndTextMessage(): StoredMessage {
    const id = 'msg-think';
    return partMessage(id, [
      reasoningPart('reasoning-1', id),
      stubTextPart({ id: `text-${id}`, sessionID: ROOT_ID, messageID: id, text: 'Visible answer' }),
    ]);
  }

  it('renders thinking when the option is off', async () => {
    hideThinking.current = false;
    const view = await mountDetails([reasoningAndTextMessage()]);

    expect(reasoningRenderers(view.renderer)).toHaveLength(1);
    expect(renderedText(view.renderer.root)).toContain('Visible answer');
  });

  it('hides thinking but keeps the text when the option is on', async () => {
    hideThinking.current = true;
    const view = await mountDetails([reasoningAndTextMessage()]);

    expect(reasoningRenderers(view.renderer)).toHaveLength(0);
    expect(renderedText(view.renderer.root)).toContain('Visible answer');
  });

  it('does not paint thinking before the preference resolves on cold start', async () => {
    hideThinking.current = false;
    hideThinking.loaded = false;
    const view = await mountDetails([reasoningAndTextMessage()]);

    expect(reasoningRenderers(view.renderer)).toHaveLength(0);
    expect(renderedText(view.renderer.root)).toContain('Visible answer');
  });

  it('drops a reasoning-only message from the transcript but keeps it in the working indicator', async () => {
    hideThinking.current = true;
    const message = partMessage('msg-think-only', [
      reasoningPart('reasoning-only', 'msg-think-only'),
    ]);
    const view = await mountDetails([message]);
    act(() => {
      view.store.set<SessionStatusIndicator | null, [SessionStatusIndicator | null], unknown>(
        view.manager.atoms.statusIndicator,
        { type: 'info', message: 'Session status', timestamp: 0 }
      );
    });

    expect(reasoningRenderers(view.renderer)).toHaveLength(0);
    expect(view.renderer.root.findAllByType(MessageBubble)).toHaveLength(0);
    expect(
      view.renderer.root.findAll(node => Object.is(node.type, 'TranscriptTimeMarker'))
    ).toHaveLength(0);
    expect(view.renderer.root.findAllByType(EmptyState)).toHaveLength(0);

    const indicator = view.renderer.root.findByType(WorkingIndicator);
    const indicatorMessages = indicator.props.messages as StoredMessage[];
    expect(indicatorMessages.some(candidate => candidate.info.id === 'msg-think-only')).toBe(true);
    expect(
      indicatorMessages.some(candidate => candidate.parts.some(part => part.type === 'reasoning'))
    ).toBe(true);
  });

  // The running child's sheet is the surface the composer spinner rule also
  // covers: the option hides the thinking row inside the sheet without changing
  // the spinner label, which still derives from the reasoning part.
  const RUNNING_CHILD = kiloId('ses-sibling-0');

  function childReasoningMessage(sessionId: KiloSessionId): StoredMessage {
    const id = `msg-${sessionId}`;
    return {
      info: { ...assistantMessage(id).info, sessionID: sessionId },
      parts: [
        {
          id: `reasoning-${sessionId}`,
          sessionID: sessionId,
          messageID: id,
          type: 'reasoning',
          text: 'hidden chain of thought',
          time: { start: 1, end: 2 },
        },
      ],
    };
  }

  function childTextMessage(sessionId: KiloSessionId, text: string): StoredMessage {
    const id = `msg-${sessionId}`;
    return {
      info: { ...assistantMessage(id).info, sessionID: sessionId },
      parts: [stubTextPart({ id: `text-${sessionId}`, sessionID: sessionId, messageID: id, text })],
    };
  }

  async function openRunningChildSheet(hide: boolean) {
    hideThinking.current = hide;
    const view = await mountDetails();
    pressCard(view.renderer, RUNNING_CHILD);
    return view;
  }

  function childSheetText(view: Awaited<ReturnType<typeof mountDetails>>) {
    return renderedText(view.renderer.root.findByType(ChildSessionSheet));
  }

  it('keeps the subagent sheet spinner on Thinking while the reasoning row is hidden', async () => {
    const view = await openRunningChildSheet(true);
    await view.respond(RUNNING_CHILD, [childReasoningMessage(RUNNING_CHILD)]);

    const sheetText = childSheetText(view);
    expect(sheetText).toContain('Thinking');
    expect(sheetText).not.toContain('hidden chain of thought');
  });

  it('keeps the in-transcript task card on Thinking while the reasoning row is hidden', async () => {
    const view = await openRunningChildSheet(true);
    await view.respond(RUNNING_CHILD, [childReasoningMessage(RUNNING_CHILD)]);

    expect(renderedText(cardFor(view.renderer, RUNNING_CHILD))).toContain('Thinking');
  });

  it('renders no empty padded row for a reasoning-only child message', async () => {
    const view = await openRunningChildSheet(true);
    await view.respond(RUNNING_CHILD, [childReasoningMessage(RUNNING_CHILD)]);

    const sheet = view.renderer.root.findByType(ChildSessionSheet);
    const list = sheet.findByType(SessionMessageList);
    expect(list.props.items).toHaveLength(0);
    expect(sheet.findAllByType(EmptyState)).toHaveLength(0);
    expect(list.props.ListFooterComponent).toBeDefined();
  });

  it('keeps a nested task card on Thinking while the reasoning row is hidden', async () => {
    const runningNested = kiloId('ses-nested-running');
    const view = await openRunningChildSheet(true);
    const selected = taskMessage(RUNNING_CHILD, [NESTED_ID, runningNested]);
    selected.parts.push(...childMessage(RUNNING_CHILD, 'Selected child row').parts);
    await view.respond(RUNNING_CHILD, [selected]);

    pressCard(view.renderer, runningNested);
    await view.respond(runningNested, [childReasoningMessage(runningNested)]);
    pressCard(view.renderer, RUNNING_CHILD);

    expect(renderedText(cardFor(view.renderer, runningNested))).toContain('Thinking');
  });

  it('shows the subagent reasoning row and the Thinking spinner when the option is off', async () => {
    const view = await openRunningChildSheet(false);
    await view.respond(RUNNING_CHILD, [childReasoningMessage(RUNNING_CHILD)]);

    const sheetText = childSheetText(view);
    expect(sheetText).toContain('Thinking');
    expect(sheetText).toContain('hidden chain of thought');
  });

  it.each([true, false])(
    'shows no reasoning row and the non-thinking spinner label in the subagent sheet (option %s)',
    async hide => {
      const view = await openRunningChildSheet(hide);
      await view.respond(RUNNING_CHILD, [childTextMessage(RUNNING_CHILD, 'Only text')]);

      const sheetText = childSheetText(view);
      expect(sheetText).not.toContain('hidden chain of thought');
      expect(sheetText).toContain('Writing response');
    }
  );
});

describe('session detail composer after a failed turn', () => {
  /**
   * The Pylon 28248 record: a session open/turn failure lands as the SDK's
   * generic transient status ("Something went wrong. Please retry in a
   * moment."), the transcript is empty and the manager cannot send. The user
   * must still be able to type the next message, with Retry kept beside it.
   */
  it('keeps the composer editable while the terminal error keeps its Retry', async () => {
    const view = await mountDetails([]);
    act(() => {
      view.store.set<
        'cloud-agent' | 'read-only' | 'remote' | null,
        ['cloud-agent' | 'read-only' | 'remote' | null],
        unknown
      >(view.manager.atoms.activeSessionType, null);
      view.store.set<boolean, [boolean], unknown>(view.manager.atoms.isReadOnly, false);
      view.store.set(view.manager.atoms.isLoading, false);
      view.store.set<boolean, [boolean], unknown>(view.manager.atoms.canSend, false);
      view.store.set<SessionStatusIndicator | null, [SessionStatusIndicator | null], unknown>(
        view.manager.atoms.statusIndicator,
        {
          type: 'error',
          message: 'Something went wrong. Please retry in a moment.',
          timestamp: 0,
        }
      );
    });

    // Retry stays available in the error card.
    const error = view.renderer.root.findByType(QueryError).props as ComponentProps<
      typeof QueryError
    >;
    expect(error.message).toBe(i18n.t('agentChat.session.connectionTrouble'));
    expect(error.onRetry).toBeDefined();

    // The composer stays mounted and editable; only sending waits on the
    // session being able to accept a message again.
    const node = view.renderer.root.find(candidate => Object.is(candidate.type, 'ChatComposer'));
    expect(node.props.disabled).toBe(false);
    expect(node.props.sendDisabled).toBe(true);
  });

  it('keeps the composer sendable after a non-retryable turn failure', async () => {
    const view = await mountDetails([]);
    act(() => {
      view.store.set<
        'cloud-agent' | 'read-only' | 'remote' | null,
        ['cloud-agent' | 'read-only' | 'remote' | null],
        unknown
      >(view.manager.atoms.activeSessionType, 'cloud-agent');
      view.store.set<boolean, [boolean], unknown>(view.manager.atoms.isReadOnly, false);
      view.store.set<boolean, [boolean], unknown>(view.manager.atoms.canSend, true);
      view.store.set<SessionStatusIndicator | null, [SessionStatusIndicator | null], unknown>(
        view.manager.atoms.statusIndicator,
        {
          type: 'error',
          message: 'Insufficient credits. Please add at least $1 to continue using Cloud Agent.',
          timestamp: 0,
        }
      );
      view.store.set<string | null, [string | null], unknown>(view.manager.atoms.error, null);
    });

    // The non-retryable class keeps no Retry: the reader continues in the
    // session instead, so the composer must stay fully usable.
    const error = view.renderer.root.findByType(QueryError).props as ComponentProps<
      typeof QueryError
    >;
    expect(error.onRetry).toBeUndefined();
    const node = view.renderer.root.find(candidate => Object.is(candidate.type, 'ChatComposer'));
    expect(node.props.disabled).toBe(false);
    expect(node.props.sendDisabled).toBe(false);
  });
});

describe('SessionDetailContent goal visibility', () => {
  const pausedGoal: SessionGoal = { text: 'Ship p7 objective', status: 'paused' };

  // The store is module-level and outlives every mount here, so each case
  // starts from expanded (there is no test-only reset export).
  beforeEach(() => {
    setSessionGoalCollapsed(ROOT_ID, false);
    motionPolicy.reducedMotion = false;
  });

  function goalSectionOf(view: Awaited<ReturnType<typeof mountDetails>>) {
    const section = view.renderer.root.findAllByType(SessionGoalSection)[0];
    if (section === undefined) {
      throw new Error('Missing SessionGoalSection');
    }
    return section;
  }

  /** The Animated.View the screen draws around the fixed goal row. */
  function goalWrapperOf(view: Awaited<ReturnType<typeof mountDetails>>) {
    let node: ReactTestInstance | null = goalSectionOf(view);
    while (node != null && node.type !== ('AnimatedView' as ElementType)) {
      node = node.parent;
    }
    if (node === null) {
      throw new Error('Missing the goal wrapper');
    }
    return node;
  }

  it('shows the fixed goal row for a live session whose snapshot carries a goal', async () => {
    goalMountOptions = { goal: pausedGoal, resolvedType: 'remote' };
    const view = await mountDetails([], { displayScope: PERSONAL_DISPLAY_SCOPE });
    const section = view.renderer.root.findAllByType(SessionGoalSection);
    expect(section).toHaveLength(1);
    expect(section[0]?.props.goal).toEqual(pausedGoal);
  });

  it('hides the fixed goal row for a read-only session whose snapshot carries a goal', async () => {
    goalMountOptions = { goal: pausedGoal, resolvedType: 'read-only' };
    const view = await mountDetails([], { displayScope: PERSONAL_DISPLAY_SCOPE });
    expect(view.renderer.root.findAllByType(SessionGoalSection)).toHaveLength(0);
  });

  it('persists the goal disclosure through the per-session store', async () => {
    goalMountOptions = { goal: pausedGoal, resolvedType: 'remote' };
    const view = await mountDetails([], { displayScope: PERSONAL_DISPLAY_SCOPE });
    expect(goalSectionOf(view).props.collapsed).toBe(false);

    act(() => {
      (goalSectionOf(view).props.onToggleCollapsed as () => void)();
    });

    expect(goalSectionOf(view).props.collapsed).toBe(true);
    expect(isSessionGoalCollapsed(ROOT_ID)).toBe(true);
  });

  it('keeps the collapsed goal after leaving and reopening the session', async () => {
    goalMountOptions = { goal: pausedGoal, resolvedType: 'remote' };
    const first = await mountDetails([], { displayScope: PERSONAL_DISPLAY_SCOPE });

    act(() => {
      (goalSectionOf(first).props.onToggleCollapsed as () => void)();
    });
    expect(isSessionGoalCollapsed(ROOT_ID)).toBe(true);

    // A fresh tree for the same session id reads the module store, which
    // outlives the component tree.
    const reopened = await mountDetails([], { displayScope: PERSONAL_DISPLAY_SCOPE });
    expect(goalSectionOf(reopened).props.collapsed).toBe(true);
  });

  it('drops the goal wrapper height transition under reduced motion', async () => {
    goalMountOptions = { goal: pausedGoal, resolvedType: 'remote' };

    const animated = await mountDetails([], { displayScope: PERSONAL_DISPLAY_SCOPE });
    expect(goalWrapperOf(animated).props.layout).toBeDefined();

    motionPolicy.reducedMotion = true;
    const reduced = await mountDetails([], { displayScope: PERSONAL_DISPLAY_SCOPE });
    expect(goalWrapperOf(reduced).props.layout).toBeUndefined();
  });
});

describe('SessionDetailContent last-opened record', () => {
  it('records the viewed session when the identity resolves after the first render', async () => {
    // A cold start: the session renders before `user.getMe` answers, so the
    // first visit sees no `userId`.
    currentUserId.value = undefined;
    const record = vi.mocked(recordLastOpenedSession);
    const capture = vi.mocked(captureEvent);
    record.mockClear();
    capture.mockClear();
    onTestFinished(() => {
      currentUserId.value = 'test-user';
    });

    const view = await mountDetails();

    // The view event proves the once-per-session latch already closed while the
    // identity was unknown.
    await waitFor(() => capture.mock.calls.some(call => call[0] === SESSION_VIEWED_EVENT));
    expect(record).not.toHaveBeenCalled();

    // The identity resolves: the record must still land for this session.
    currentUserId.value = 'test-user';
    await view.switchRoot(ROOT_ID);

    await waitFor(() => record.mock.calls.length > 0);
    expect(record).toHaveBeenCalledExactlyOnceWith(ROOT_ID, 'test-user');

    // A later render of the same viewed session must not record again.
    capture.mockClear();
    await view.switchRoot(ROOT_ID);
    expect(record).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('SessionDetailContent goal edit dialog', () => {
  // The reported goal shape: one very long unbroken word plus a long sentence.
  const longGoal: SessionGoal = {
    text:
      'the_number_of_consecutive_days_the_workflow_has_not_failed_for_the_first_time_due_to' +
      '_workflow_issues_is_0_for_3_consecutive_days and the scheduled cleanup job keeps reporting',
    status: 'active',
  };

  it('opens the goal text in a wrapping field', async () => {
    goalMountOptions = { goal: longGoal, resolvedType: 'remote' };
    const view = await mountDetails([], { displayScope: PERSONAL_DISPLAY_SCOPE });
    const section = view.renderer.root.findAllByType(SessionGoalSection)[0];
    if (!section) {
      throw new Error('goal section did not render');
    }
    const { onPress } = section.props as { onPress: () => void };
    act(onPress);

    // Pick "Edit goal" out of the goal action sheet.
    const sheetCall = showActionSheetWithOptions.mock.calls.at(-1);
    expect(sheetCall).toBeDefined();
    const sheet = sheetCall?.[0] as { options: string[] } | undefined;
    const onSelect = sheetCall?.[1];
    const editIndex = sheet?.options.indexOf(i18n.t('agentChat.goal.edit')) ?? -1;
    expect(editIndex).toBeGreaterThanOrEqual(0);
    act(() => {
      onSelect?.(editIndex);
    });

    // The dialog must hand the goal text to the modal's wrapping field, not a
    // single-line one that clips its start.
    const modal = view.renderer.root.findAllByType('RenameModal')[0];
    expect(modal?.props).toMatchObject({
      multiline: true,
      maxLength: 500,
      initialValue: longGoal.text,
    });
  });
});

// The screen's live position: the transcript list reports the topmost visible
// message, and the screen publishes it to the OS handoff, the copy-link action,
// and the route's search params.
describe('SessionDetailContent live position', () => {
  it('publishes the transcript position to the handoff, the copy action, and the route', async () => {
    vi.mocked(Clipboard.setStringAsync).mockResolvedValue(true);
    routerSetParams.mockClear();
    handoffAdvertiserCalls.props.length = 0;
    const view = await mountDetails([childMessage(ROOT_ID, 'shown row')]);

    const list = view.renderer.root.findAllByType(SessionMessageList)[0];
    if (!list) {
      throw new Error('transcript list did not render');
    }
    act(() => {
      (list.props as ComponentProps<typeof SessionMessageList>).onAnchorChange?.('msg-77');
    });

    // The handoff advertises the position the transcript is showing.
    expect(handoffAdvertiserCalls.props.at(-1)?.anchorMessageId).toBe('msg-77');

    // The header's copy action copies that same position's universal link.
    const copy = view.renderer.root.findByProps({
      accessibilityLabel: i18n.t('common.copyLink'),
    });
    await act(async () => {
      (copy.props as { onPress: () => void }).onPress();
      await Promise.resolve();
    });
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      sessionResumeUrl({ sessionId: ROOT_ID, anchorMessageId: 'msg-77' })
    );

    // The route's search params carry it after the publish debounce.
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 600);
      });
    });
    expect(routerSetParams).toHaveBeenCalledWith({ at: 'msg-77' });
  });
});

// A resume link delivered onto a screen that already shows the session arrives
// as a new `resumeAt` param (dedupe updates params, it does not remount): the
// screen must adopt the link's position, while the route echoing back what this
// screen itself published must not re-scroll the viewport.
describe('SessionDetailContent resume link', () => {
  function resumeAnchorOf(view: Awaited<ReturnType<typeof mountDetails>>) {
    const list = view.renderer.root.findAllByType(SessionMessageList)[0];
    if (!list) {
      throw new Error('transcript list did not render');
    }
    return (list.props as ComponentProps<typeof SessionMessageList>).resumeAt;
  }

  it('adopts a resume link delivered to the already-mounted screen', async () => {
    const view = await mountDetails([childMessage(ROOT_ID, 'shown row')], {
      resumeAt: 'msg-a',
    });
    expect(resumeAnchorOf(view)).toBe('msg-a');

    await view.updateResumeAt('msg-b');

    expect(resumeAnchorOf(view)).toBe('msg-b');
  });

  it('cancels a pending position publish when a newer resume link is adopted', async () => {
    routerSetParams.mockClear();
    const view = await mountDetails([childMessage(ROOT_ID, 'shown row')], {
      resumeAt: 'msg-a',
    });
    const list = view.renderer.root.findAllByType(SessionMessageList)[0];
    if (!list) {
      throw new Error('transcript list did not render');
    }
    const onAnchorChange = (list.props as ComponentProps<typeof SessionMessageList>).onAnchorChange;
    // The viewport moves, arming the debounced publish...
    act(() => {
      onAnchorChange?.('msg-c');
    });
    // ...and a resume link lands before the debounce fires.
    await view.updateResumeAt('msg-b');
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 600);
      });
    });

    expect(resumeAnchorOf(view)).toBe('msg-b');
    // The pre-link position must not overwrite the link's position on the route.
    expect(routerSetParams).not.toHaveBeenCalledWith({ at: 'msg-c' });
  });

  it('keeps the current position when the route echoes the anchor this screen published', async () => {
    routerSetParams.mockClear();
    const view = await mountDetails([childMessage(ROOT_ID, 'shown row')], {
      resumeAt: 'msg-a',
    });
    const list = view.renderer.root.findAllByType(SessionMessageList)[0];
    if (!list) {
      throw new Error('transcript list did not render');
    }
    act(() => {
      (list.props as ComponentProps<typeof SessionMessageList>).onAnchorChange?.('msg-c');
    });

    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 600);
      });
    });
    expect(routerSetParams).toHaveBeenCalledWith({ at: 'msg-c' });

    await view.updateResumeAt('msg-c');

    expect(resumeAnchorOf(view)).toBe('msg-a');
  });
});

// A send takes the transcript position over: both composer send paths must
// tell the list to follow the output the send produces, so a transcript parked
// on a `?at=` anchor with follow off never strands the sent message and its
// reply off-screen (mobile-app e2e e1).
describe('SessionDetailContent send transcript take-over', () => {
  function makeSendable(view: Awaited<ReturnType<typeof mountDetails>>) {
    act(() => {
      view.store.set(view.manager.atoms.activeSessionType, 'remote');
      view.store.set(view.manager.atoms.isReadOnly, false);
      view.store.set(view.manager.atoms.canSend, true);
    });
  }

  function followTailNonceOf(view: Awaited<ReturnType<typeof mountDetails>>) {
    const list = view.renderer.root.findAllByType(SessionMessageList)[0];
    if (!list) {
      throw new Error('transcript list did not render');
    }
    return (list.props as ComponentProps<typeof SessionMessageList>).followTailNonce;
  }

  it('takes the position over when a prompt is sent from a resumed anchor', async () => {
    const view = await mountDetails([childMessage(ROOT_ID, 'shown row')], { resumeAt: 'msg-a' });
    makeSendable(view);
    expect(followTailNonceOf(view)).toBe(0);

    const composer = view.renderer.root.findAll(node => Object.is(node.type, 'ChatComposer'))[0];
    if (!composer) {
      throw new Error('composer did not render');
    }
    const onSend = composer.props.onSend as (text: string) => Promise<void>;
    await act(async () => {
      // The transport outcome does not gate the take-over: the viewport must
      // follow the send as soon as the user commits it.
      await onSend('follow-after-resume').catch(() => undefined);
    });

    expect(followTailNonceOf(view)).toBe(1);
  });

  it('takes the position over when a slash command is sent from a resumed anchor', async () => {
    const view = await mountDetails([childMessage(ROOT_ID, 'shown row')], { resumeAt: 'msg-a' });
    makeSendable(view);

    const composer = view.renderer.root.findAll(node => Object.is(node.type, 'ChatComposer'))[0];
    if (!composer) {
      throw new Error('composer did not render');
    }
    const onSendCommand = composer.props.onSendCommand as (
      command: string,
      argumentsText: string
    ) => Promise<boolean>;
    await act(async () => {
      await onSendCommand('review', '').catch(() => undefined);
    });

    expect(followTailNonceOf(view)).toBe(1);
  });
});

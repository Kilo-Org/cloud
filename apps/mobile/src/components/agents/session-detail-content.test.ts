/* eslint-disable max-lines -- Keep the detail trigger and real SDK request regressions with their shared screen fixture. */
/* eslint-disable typescript-eslint/no-deprecated -- The repository uses react-test-renderer for DOM-free native component tests. */
import { type ComponentProps, createElement, Fragment } from 'react';
import { createStore, Provider } from 'jotai';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { type Pressable } from 'react-native';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createSessionManager,
  createUserWebConnection,
  type KiloSessionId,
  type SessionManager,
  type SessionSnapshotPageOutcome,
  type SessionStatusIndicator,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import { kiloId, stubTextPart } from '@kilocode/cloud-agent-sdk/test-helpers';

import { ChildSessionSection } from '@/components/agents/child-session-section';
import { ChildSessionModelLabel } from '@/components/agents/child-session-model-label';
import { ChildSessionSheet } from '@/components/agents/child-session-sheet';
import { getTaskToolSessionId } from '@/components/agents/child-session-card-state';
import { assistantMessage } from '@/components/agents/message-bubble-test-utils';
import { SessionDetailContent } from '@/components/agents/session-detail-content';
import { SessionSkeletonMessages } from '@/components/agents/session-detail-skeleton';
import { type SessionMessageList } from '@/components/agents/session-message-list';
import {
  resolveSendAttachmentKind,
  shouldRefuseSilentAttachmentDrop,
} from '@/components/agents/session-detail-send-attachment';
import { ContextControl } from '@/components/context-control';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { i18n } from '@/i18n';
import { renderWithProviders } from '@/test/render-with-providers';

const managerSlot = vi.hoisted(() => ({ current: null as SessionManager | null }));
vi.mock('@/components/agents/session-provider', () => ({
  useSessionManager: () => {
    if (!managerSlot.current) {
      throw new Error('Missing test session manager');
    }
    return managerSlot.current;
  },
}));

// Keep the actual detail/card/sheet/header callbacks and SDK. Replace native
// rendering and unrelated composer, account, model-picker, and router dependencies.
const navigationRoutes = vi.hoisted(() => ['session-detail']);
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  LinearTransition: { duration: () => ({}) },
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
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Error: 'error', Success: 'success' },
}));
vi.mock('@/components/agents/mobile-session-manager', () => ({
  isCancelQueuedUpgradeRequired: vi.fn(),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  ChevronDown: 'ChevronDown',
  Clock: 'Clock',
  Loader2: 'Loader2',
  MessageSquare: 'MessageSquare',
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
vi.mock('@/components/agents/session-connection-indicator', () => ({
  SessionConnectionIndicator: 'SessionConnectionIndicator',
}));
vi.mock('@/components/agents/session-context-metrics', () => ({
  SessionContextMetrics: 'SessionContextMetrics',
}));
vi.mock('@/components/agents/session-context-sheet', () => ({
  SessionContextSheet: 'SessionContextSheet',
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
vi.mock('@/components/agents/working-indicator', () => ({ WorkingIndicator: 'WorkingIndicator' }));
vi.mock('@/components/agents/compaction-separator', () => ({
  CompactionSeparator: 'CompactionSeparator',
}));
vi.mock('@/components/agents/file-part-renderer', () => ({ FilePartRenderer: 'FilePartRenderer' }));
vi.mock('@/components/agents/reasoning-part-renderer', () => ({
  ReasoningPartRenderer: 'ReasoningPartRenderer',
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
      )
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
  useInteractionHandlers: () => ({}),
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
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'test-user', isLoading: false }),
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
vi.mock('@/lib/hooks/use-keep-screen-on-preference', () => ({
  useKeepScreenOnPreference: () => ({ keepScreenOn: false, hasLoaded: true }),
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
  }),
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

const PERSONAL_DISPLAY_SCOPE = { organizationId: null, isResolved: true };
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

function page(sessionId: KiloSessionId, messages: StoredMessage[]): SessionSnapshotPageOutcome {
  return {
    kind: 'success',
    info: { id: sessionId },
    messages,
    nextCursor: null,
    omittedItemCount: 0,
  };
}

beforeEach(() => {
  navigationRoutes.splice(0, navigationRoutes.length, 'session-detail');
  openRenameModal.mockClear();
  globalContext.organizationId = 'global-org';
  globalContext.setOrganizationId.mockClear();
});

async function mountDetails(
  rootMessages = [taskMessage(ROOT_ID, CHILD_IDS)],
  metadataReady?: Promise<undefined>,
  displayScope: ComponentProps<typeof SessionDetailContent>['displayScope'] = PERSONAL_DISPLAY_SCOPE
) {
  const store = createStore();
  const rootPages = new Map([[ROOT_ID, rootMessages]]);
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
      return { type: 'read-only', kiloSessionId: id };
    },
    getTicket: vi.fn(),
    fetchSnapshot: vi.fn(),
    fetchSnapshotPage: async id => {
      const response = Promise.withResolvers<SessionSnapshotPageOutcome | null>();
      requests.push({ id, response });
      const messages = rootPages.get(id);
      if (messages) {
        response.resolve(page(id, messages));
      }
      const outcome = await response.promise;
      return outcome;
    },
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
        organizationId: null,
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
  const element = (id: KiloSessionId) =>
    createElement(
      Provider,
      { store },
      createElement(SessionDetailContent, { key: id, sessionId: id, displayScope })
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
        requestFor(id).resolve(page(id, messages));
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
        view.renderer.update(
          createElement(QueryClientProvider, { client: view.queryClient }, element(id))
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
    const { renderer } = await mountDetails([], undefined, {
      organizationId: state.organizationId,
      isResolved: state.isResolved,
    });
    const header = renderer.root.findByType(ScreenHeader);
    expect(header.findByProps({ accessibilityRole: 'header' }).props).toMatchObject({
      numberOfLines: 1,
      ellipsizeMode: 'tail',
    });
    expect(header.props.context).toBeUndefined();
    expect(header.findAllByType(ContextControl)).toHaveLength(0);
    expect(
      header.findAll(node => node.props.accessibilityHint === i18n.t('profile.selectAccount'))
    ).toHaveLength(0);
    expect(header.findByProps({ accessibilityLabel: i18n.t('screenHeader.goBack') })).toBeDefined();
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
    const view = await mountDetails([], metadata.promise);
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
      numberOfLines: 1,
      ellipsizeMode: 'tail',
    });
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
      waiting: false,
    },
    {
      sessionId: kiloId('ses-sibling-0'),
      status: 'running',
      text: 'Researcher\nTask ses-sibling-0\nWaiting for activity\nrunning',
      textRows: 4,
      waiting: true,
    },
    {
      sessionId: kiloId('ses-sibling-1'),
      status: 'error',
      text: 'Researcher\nTask ses-sibling-1\nerror',
      textRows: 3,
      waiting: false,
    },
  ] as const)(
    'renders the $status card without fetching a child transcript for labels',
    async ({ sessionId, status, text, textRows, waiting }) => {
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
      expect(button.accessibilityLabel?.includes('Waiting for activity')).toBe(waiting);
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
        `Researcher\nTask ${nestedId}${isRunning ? '\nWaiting for activity' : ''}\n${status}`
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
      expect(nestedButton.accessibilityLabel?.includes('Waiting for activity')).toBe(isRunning);
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

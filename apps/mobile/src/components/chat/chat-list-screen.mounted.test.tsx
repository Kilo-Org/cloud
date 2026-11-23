/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/render-with-providers.tsx) */
/* eslint-disable max-lines -- one mount harness; the list-provenance matrix is the point */
import { createElement, type ElementType } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatListScreen } from '@/components/chat/chat-list-screen';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { i18n } from '@/i18n';
import { renderWithProviders } from '@/test/render-with-providers';
import { type StoredChatBackend } from '@/lib/chat/backend-store';
import { backendTargetId } from '@/lib/chat/backend-target';
import { type BannerState } from '@/lib/offline-banner-state';

/**
 * Starting a chat from the list.
 *
 * The button creates a session and opens it. What it does when the session
 * cannot be created is the point: a button that fails silently reads as one
 * that does not work.
 */

const state = vi.hoisted(() => ({
  newChat: vi.fn<(place: unknown, target: unknown) => Promise<string>>(),
  push: vi.fn<(path: string) => void>(),
  toastError: vi.fn<(message: string, options?: unknown) => void>(),
  toastDismiss: vi.fn<(id?: string | number) => void>(),
  chats: [] as { sessionId: string; model: string; title: string; updatedAt: number }[],
  backends: [] as StoredChatBackend[],
  // The list read's own answer: only an answered list may say there are no
  // chats (see `selectChatListSurface`).
  listAnswered: true,
  listFailed: false,
  listLoading: false,
  // The catalog read's answer, and the device's confirmed connectivity.
  catalogAnswered: true,
  catalogLoading: false,
  catalogFailed: false,
  models: [{ id: 'm1', name: 'One', isPreferred: true }] as {
    id: string;
    name: string;
    isPreferred: boolean;
  }[],
  connectivity: 'online' as BannerState,
  // The reset notice's own state, and the dismiss control the card calls.
  resetNotice: 'absent' as 'loading' | 'absent' | 'present',
  dismissResetNotice: vi.fn<() => void>(),
}));

vi.mock('@/lib/haptics', () => ({ selectionHaptic: vi.fn() }));
vi.mock('@/lib/chat/use-chat', () => ({
  useChatPlace: () => ({ chatScope: 'u1:personal', org: { kind: 'personal' } }),
  newChat: state.newChat,
  useChatList: () => ({
    chats: state.chats,
    isLoading: state.listLoading,
    isError: state.listFailed,
    isSuccess: state.listAnswered,
    refetch: () => undefined,
    remove: async () => {
      await Promise.resolve();
    },
  }),
}));
vi.mock('@/lib/chat/layers', () => ({ rememberModelFacts: () => undefined }));
vi.mock('@/lib/chat/sync/use-chat-sync', () => ({
  useChatSyncGate: () => ({ state: { kind: 'off' }, enabled: false, decide: async () => undefined }),
  useChatSyncUploader: () => undefined,
  useSyncBanner: () => ({ kind: 'none' }),
  useDeletedElsewhere: () => undefined,
  useChatSyncNotice: () => ({ visible: false, dismiss: () => undefined }),
  useMergedChatList: () => ({
    surface: { kind: 'off' },
    rows: [],
    hasNextPage: false,
    fetchNextPage: () => undefined,
    refetch: () => undefined,
    nextPageFailed: false,
  }),
}));
vi.mock('@/lib/chat/sync/sync-send', () => ({
  prepareSend: async () => ({ kind: 'local' }),
}));
vi.mock('@/lib/chat/sync/sync-backfill-run', () => ({
  startBackfill: async () => undefined,
}));
vi.mock('@/lib/chat/sync/sync-service', () => ({
  prepareSend: async () => ({ kind: 'local' }),
  pullOpenedChat: async () => undefined,
  discardAndReload: async () => '',
  registerSyncUploader: () => () => undefined,
  bannerOf: () => ({ kind: 'none' }),
  watchBanners: () => () => undefined,
  onDeletedElsewhere: () => () => undefined,
  uploadSettledChat: async () => undefined,
  uploadRenamedChat: async () => undefined,
  deleteEverywhere: async () => ({ kind: 'local-only' }),
  deleteServerSession: async () => true,
  importServerSession: async () => null,
  startBackfill: async () => undefined,
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ authEpoch: 0 }) }));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({
    models: state.models,
    isLoading: state.catalogLoading,
    isError: state.catalogFailed,
    isFetched: state.catalogAnswered,
    refetch: () => undefined,
  }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => state.connectivity,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#fff', foreground: '#14130F' }),
}));
vi.mock('@/lib/a11y/announce', () => ({ announceForA11y: vi.fn() }));
vi.mock('@/lib/tab-bar-clearance', () => ({ useEffectiveTabBarHeight: () => 0 }));
vi.mock('@/lib/tab-bar-layout', () => ({ getEffectiveTabBarHeight: () => 0 }));
vi.mock('sonner-native', () => ({
  toast: { error: state.toastError, dismiss: state.toastDismiss },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1, width: 400, height: 800 }),
}));
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }));
vi.mock('@/components/centered-state-surface', () => ({
  StateSurfaceInsets: 'StateSurfaceInsets',
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
// The workspace row has its own suite (`chat-list-screen.workspace.mounted.test.tsx`);
// here it is stubbed so these assertions stay about starting a chat.
vi.mock('@/components/context-control', () => ({
  CONTEXT_CONTROL_INLINE_MIN_DP: 21,
  ContextControl: () => null,
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  MessageCircle: 'MessageCircle',
  MessageCirclePlus: 'MessageCirclePlus',
  Plus: 'Plus',
  Server: 'Server',
  X: 'X',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/chat/chat-row', () => ({ ChatRow: 'ChatRow' }));
vi.mock('@/components/chat/beta-pill', () => ({ BetaPill: 'BetaPill' }));
vi.mock('@/lib/chat/backend-store', () => ({ useChatBackends: () => state.backends }));
vi.mock('@/lib/chat/local-models', () => ({ useLocalModels: () => [] }));
vi.mock('@/lib/chat/gguf-models', () => ({
  useGgufModels: () => ({ models: [], download: null, failure: null }),
  ggufModelOptions: () => [],
}));
vi.mock('@/components/chat/backend-settings-sheet', () => ({
  BackendSettingsControl: 'BackendSettingsControl',
}));
vi.mock('@/lib/persist/use-local-reset-notice', () => ({
  useLocalResetNotice: () => ({
    notice: { kind: state.resetNotice },
    dismiss: state.dismissResetNotice,
  }),
}));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;

beforeEach(() => {
  vi.clearAllMocks();
  state.chats = [];
  state.backends = [];
  state.listAnswered = true;
  state.listFailed = false;
  state.listLoading = false;
  state.catalogAnswered = true;
  state.catalogLoading = false;
  state.catalogFailed = false;
  state.models = [{ id: 'm1', name: 'One', isPreferred: true }];
  state.connectivity = 'online';
  state.resetNotice = 'absent';
  state.newChat.mockResolvedValue('session-1');
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function mount(): Promise<ReactTestRenderer> {
  view = await renderWithProviders(createElement(ChatListScreen));
  return view.renderer;
}

/** Press the empty list's action, the button that starts a chat. */
async function pressStart(tree: ReactTestRenderer): Promise<void> {
  const empty = tree.root
    .findAll(node => (node.type as string) === 'EmptyState')
    .at(0) as unknown as { props: { action: { props: { onPress: () => void } } } };
  await act(async () => {
    empty.props.action.props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The corner button's pressable, the one a list with a chat already in it shows. */
function findFab(tree: ReactTestRenderer): ReactTestInstance {
  const fab = tree.root
    .findAllByProps({ testID: 'chat-new-fab' })
    .find(node => (node.type as string) === 'Pressable');
  if (!fab) {
    throw new Error('Missing chat-new-fab Pressable');
  }
  return fab;
}

async function pressFab(tree: ReactTestRenderer): Promise<void> {
  const fab = findFab(tree);
  await act(async () => {
    (fab.props.onPress as () => void)();
    await Promise.resolve();
  });
}

describe('the list body names what it knows', () => {
  function bodyNodes(tree: ReactTestRenderer, type: string) {
    return tree.root.findAll(node => (node.type as string) === type);
  }

  it('waits instead of claiming there are no chats until the list answers', async () => {
    // A read that has not answered says nothing about the rows: the empty state
    // would tell the person they have no chats while the load is still running.
    state.listAnswered = false;
    state.listLoading = true;
    const waiting = await mount();
    expect(bodyNodes(waiting, 'EmptyState')).toHaveLength(0);
    expect(bodyNodes(waiting, 'QueryError')).toHaveLength(0);
    // The skeleton is a component, not a string host: count it by type.
    expect(waiting.root.findAllByType(RowSkeleton).length).toBeGreaterThan(0);

    view?.unmount();
    state.listAnswered = true;
    state.listLoading = false;
    const answered = await mount();
    expect(bodyNodes(answered, 'EmptyState')).toHaveLength(1);
  });

  it('draws the offline card, not the empty state, when the catalog cannot answer offline', async () => {
    // Offline is not loading: the catalog never answered and no model is known,
    // so a chat cannot start and the tab must say why instead of offering an
    // inert empty state.
    state.connectivity = 'offline';
    state.catalogAnswered = false;
    state.models = [];
    const tree = await mount();
    const [error] = bodyNodes(tree, 'QueryError');
    expect(error?.props.variant).toBe('offline');
    expect(typeof error?.props.onRetry).toBe('function');
    expect(bodyNodes(tree, 'EmptyState')).toHaveLength(0);
    // A New chat button that cannot start anything is not offered either.
    expect(tree.root.findAllByProps({ testID: 'chat-new-fab' })).toHaveLength(0);
  });

  it('names a catalog failure with Retry when nothing can start a chat', async () => {
    state.catalogFailed = true;
    state.catalogAnswered = false;
    state.models = [];
    const tree = await mount();
    const [error] = bodyNodes(tree, 'QueryError');
    expect(error?.props.variant).toBe('server');
    expect(typeof error?.props.onRetry).toBe('function');
    expect(bodyNodes(tree, 'EmptyState')).toHaveLength(0);
  });

  it('keeps the empty state for a list that answered with no chats', async () => {
    const tree = await mount();
    const [empty] = bodyNodes(tree, 'EmptyState');
    expect(bodyNodes(tree, 'EmptyState')).toHaveLength(1);
    expect(bodyNodes(tree, 'QueryError')).toHaveLength(0);
    // The one true empty state still invites the person to start a chat, with
    // an action that can run: an answered list and an answered catalog.
    expect(empty?.props.title).toBe(i18n.t('modelChat.empty.title'));
    expect(empty?.props.action).toBeDefined();
  });

  it('keeps answered rows, and the button that starts one, when the catalog fails', async () => {
    // The list is the device's own answer. A failed catalog read must not
    // replace readable chats — or the way to start another — with a card.
    state.chats = [{ sessionId: 's1', model: 'm1', title: 'First chat', updatedAt: 1 }];
    state.catalogFailed = true;
    state.catalogAnswered = false;
    const tree = await mount();
    // The list is a FlashList (stubbed here), so its data is the readable rows.
    expect(bodyNodes(tree, 'FlashList')[0]?.props.data).toHaveLength(1);
    expect(bodyNodes(tree, 'QueryError')).toHaveLength(0);
    expect(bodyNodes(tree, 'EmptyState')).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'chat-new-fab' }).length).toBeGreaterThan(0);
  });

  it('keeps answered rows while the catalog is still loading', async () => {
    // The catalog's first read holds `isLoading` only while it has no data, so a
    // loading catalog has no models: nothing can start a chat yet. The chats the
    // device already holds are still the list's own answer and stay on screen.
    state.chats = [{ sessionId: 's1', model: 'm1', title: 'First chat', updatedAt: 1 }];
    state.catalogAnswered = false;
    state.catalogLoading = true;
    state.models = [];
    const tree = await mount();
    expect(bodyNodes(tree, 'FlashList')[0]?.props.data).toHaveLength(1);
    expect(bodyNodes(tree, 'QueryError')).toHaveLength(0);
    expect(bodyNodes(tree, 'EmptyState')).toHaveLength(0);
    // Nothing can start a chat until the catalog answers: no corner button.
    expect(tree.root.findAllByProps({ testID: 'chat-new-fab' })).toHaveLength(0);
  });

  it('keeps the empty state and its action when the catalog fails but a model is known', async () => {
    // Cached catalog rows, a configured backend or an on-device model still
    // start a chat, so the empty state keeps the one thing it offers.
    state.catalogFailed = true;
    state.catalogAnswered = false;
    const tree = await mount();
    const [empty] = bodyNodes(tree, 'EmptyState');
    expect(bodyNodes(tree, 'EmptyState')).toHaveLength(1);
    expect(bodyNodes(tree, 'QueryError')).toHaveLength(0);
    expect(empty?.props.action).toBeDefined();
  });

  it('names a failed list with Retry', async () => {
    state.listFailed = true;
    const tree = await mount();
    const [error] = bodyNodes(tree, 'QueryError');
    expect(error?.props.variant).toBe('server');
    expect(typeof error?.props.onRetry).toBe('function');
    expect(bodyNodes(tree, 'EmptyState')).toHaveLength(0);
  });
});

describe('the local reset notice', () => {
  it('explains a reset above the empty state, not instead of it', async () => {
    state.resetNotice = 'present';
    const tree = await mount();

    const card = tree.root.findAllByProps({ testID: 'chat-reset-notice' });
    expect(card.length).toBeGreaterThan(0);

    const text = tree.root
      .findAll(node => (node.type as string) === 'Text')
      .map(node => node.props.children as string);
    expect(text).toContain(i18n.t('modelChat.list.resetNoticeTitle'));
    expect(text).toContain(i18n.t('modelChat.list.resetNoticeBody'));
    // The emptied list keeps its own answer under the explanation.
    expect(tree.root.findAll(node => (node.type as string) === 'EmptyState')).toHaveLength(1);
  });

  it('dismisses once from the card control', async () => {
    state.resetNotice = 'present';
    const tree = await mount();

    const dismiss = tree.root.find(
      node =>
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === i18n.t('modelChat.list.resetNoticeDismiss')
    );
    await act(async () => {
      (dismiss.props.onPress as () => void)();
      await Promise.resolve();
    });

    expect(state.dismissResetNotice).toHaveBeenCalledTimes(1);
  });

  it('draws no card in the empty state when there was no reset', async () => {
    state.resetNotice = 'absent';
    const tree = await mount();

    expect(tree.root.findAllByProps({ testID: 'chat-reset-notice' })).toHaveLength(0);
    expect(tree.root.findAll(node => (node.type as string) === 'EmptyState')).toHaveLength(1);
  });

  it('draws no card over answered rows when there was no reset', async () => {
    state.resetNotice = 'absent';
    state.chats = [{ sessionId: 's1', model: 'm1', title: 'First chat', updatedAt: 1 }];
    const tree = await mount();

    expect(tree.root.findAllByProps({ testID: 'chat-reset-notice' })).toHaveLength(0);
    expect(tree.root.findAll(node => (node.type as string) === 'FlashList')).toHaveLength(1);
  });
});

describe('starting a chat from the list', () => {
  it('creates the chat and opens it', async () => {
    const tree = await mount();

    await pressStart(tree);

    expect(state.newChat).toHaveBeenCalledWith(expect.anything(), { model: 'm1', effort: null });
    expect(state.push).toHaveBeenCalledWith('/(app)/(tabs)/(4_chat)/session-1');
    expect(state.toastError).not.toHaveBeenCalled();
    // A failure left on screen from an earlier attempt is moot now.
    expect(state.toastDismiss).toHaveBeenCalledWith('chat-start-failed');
  });

  it('says what went wrong and keeps it on screen when the chat cannot be started', async () => {
    state.newChat.mockRejectedValue(new Error('the store is not open'));
    const tree = await mount();

    await pressStart(tree);

    // A four-second toast was missed by whoever looked away, so the failure
    // stays until it is dismissed, above the tab bar it must never cover.
    expect(state.toastError).toHaveBeenCalledWith('the store is not open', {
      id: 'chat-start-failed',
      position: 'top-center',
      duration: Infinity,
      closeButton: true,
    });
    expect(state.push).not.toHaveBeenCalled();
  });

  it('shows the new-chat button busy and ignores a second press while the chat starts', async () => {
    state.chats = [{ sessionId: 'older', model: 'm1', title: 'Older', updatedAt: 1 }];
    // A chat that is slow to start: the button must say so for as long as it takes.
    const pending: { resolve?: (sessionId: string) => void } = {};
    state.newChat.mockReturnValue(
      new Promise<string>(resolve => {
        pending.resolve = resolve;
      })
    );
    const tree = await mount();

    await pressFab(tree);

    const busy = findFab(tree);
    expect(busy.props.disabled).toBe(true);
    expect(busy.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(tree.root.findAllByType('ActivityIndicator' as ElementType)).toHaveLength(1);

    // A second tap while it works is what opened a second chat before.
    await pressFab(tree);
    expect(state.newChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve?.('session-1');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.push).toHaveBeenCalledWith('/(app)/(tabs)/(4_chat)/session-1');
    expect(findFab(tree).props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
  });

  it('starts the chat on the model the latest chat is on', async () => {
    const backend: StoredChatBackend = {
      id: 'custom-server',
      revision: 1,
      name: 'Custom',
      baseUrl: 'https://custom.example/v1',
      apiKind: 'chat_completions',
      apiKey: '',
      headers: {},
      models: [
        { id: 'custom-model', name: 'Custom model', tools: false, images: false, reasoning: false },
      ],
      allowLocalHttp: false,
    };
    state.backends = [backend];
    const target = backendTargetId(backend, 'custom-model');
    state.chats = [
      { sessionId: 'latest', model: target, title: 'Latest', updatedAt: 2 },
      { sessionId: 'older', model: 'm1', title: 'Older', updatedAt: 1 },
    ];
    const tree = await mount();

    await pressFab(tree);

    expect(state.newChat).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      model: target,
      effort: null,
    });
  });
});

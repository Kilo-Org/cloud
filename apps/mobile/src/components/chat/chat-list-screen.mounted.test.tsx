/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/render-with-providers.tsx) */
import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ElementType, isValidElement } from 'react';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ChatListScreen } from '@/components/chat/chat-list-screen';
import { renderWithProviders } from '@/test/render-with-providers';
import { type StoredChatBackend } from '@/lib/chat/backend-store';
import { backendTargetId } from '@/lib/chat/backend-target';

/**
 * Starting a chat from the list.
 *
 * The button creates a session and opens it. What it does when the session
 * cannot be created is the point: a button that fails silently reads as one
 * that does not work.
 */

const state = vi.hoisted(() => ({
  newChat: vi.fn<(place: unknown, model: string) => Promise<string>>(),
  push: vi.fn<(path: string) => void>(),
  toastError: vi.fn<(message: string, options?: unknown) => void>(),
  toastDismiss: vi.fn<(id?: string | number) => void>(),
  chats: [] as { sessionId: string; model: string; title: string; updatedAt: number }[],
  backends: [] as StoredChatBackend[],
}));

vi.mock('@/lib/chat/use-chat', () => ({
  chatPlaceOf: () => ({ chatScope: 'u1:personal', org: { kind: 'personal' } }),
  newChat: state.newChat,
  useChatList: () => ({
    chats: state.chats,
    isLoading: false,
    isError: false,
    refetch: () => undefined,
    remove: async () => {
      await Promise.resolve();
    },
  }),
}));
vi.mock('@/lib/chat/layers', () => ({ rememberModelFacts: () => undefined }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ authEpoch: 0 }) }));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1' }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({
    models: [{ id: 'm1', name: 'One', isPreferred: true }],
    isError: false,
    refetch: () => undefined,
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#fff' }),
}));
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
vi.mock('@/components/agents/session-list-content', () => ({ FAB_MARGIN: 16, FAB_SIZE: 56 }));
vi.mock('@/components/centered-state-surface', () => ({
  StateSurfaceInsets: 'StateSurfaceInsets',
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  MessageCircle: 'MessageCircle',
  Plus: 'Plus',
  Server: 'Server',
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
vi.mock('@/components/agents/model-selector', () => ({ ModelSelector: 'ModelSelector' }));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;

beforeEach(() => {
  vi.clearAllMocks();
  state.chats = [];
  state.backends = [];
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

/** Press the corner button, the one a list with a chat already in it shows. */
async function pressFab(tree: ReactTestRenderer): Promise<void> {
  const fab = tree.root.findByProps({ testID: 'chat-new-fab' });
  await act(async () => {
    (fab.props as { onPress: () => void }).onPress();
    await Promise.resolve();
  });
}

function isHandler(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

/** Pick a model in the selector, as the user does. */
async function selectModel(tree: ReactTestRenderer, model: string): Promise<void> {
  const { onSelect } = tree.root.findByType('ModelSelector' as ElementType).props;
  if (!isHandler(onSelect)) {
    throw new TypeError('ModelSelector has no select handler');
  }
  await act(() => {
    onSelect(model);
  });
}

function offersModel(tree: ReactTestRenderer, model: string): boolean {
  const options: unknown = tree.root.findByType('ModelSelector' as ElementType).props.options;
  if (!Array.isArray(options)) {
    throw new TypeError('ModelSelector has no options');
  }
  return options.some(
    (option: unknown) =>
      typeof option === 'object' && option !== null && 'id' in option && option.id === model
  );
}

function startDisabled(tree: ReactTestRenderer): unknown {
  const action: unknown = tree.root.findByType('EmptyState' as ElementType).props.action;
  if (!isValidElement<{ disabled?: boolean }>(action)) {
    throw new TypeError('EmptyState has no action');
  }
  return action.props.disabled;
}

describe('starting a chat from the list', () => {
  it('creates the chat and opens it', async () => {
    const tree = await mount();

    await pressStart(tree);

    expect(state.newChat).toHaveBeenCalledWith(expect.anything(), 'm1');
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

    const busy = tree.root.findByProps({ testID: 'chat-new-fab' });
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
    expect(tree.root.findByProps({ testID: 'chat-new-fab' }).props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
  });

  it.each([
    ['edited', false],
    ['deleted', false],
    ['edited', true],
    ['deleted', true],
  ] as const)(
    'keeps an explicitly picked backend invalid after it is %s (existing chats: %s)',
    async (mutation, hasChats) => {
      const backend: StoredChatBackend = {
        id: 'custom-server',
        revision: 1,
        name: 'Custom',
        baseUrl: 'https://custom.example/v1',
        apiKind: 'chat_completions',
        apiKey: '',
        headers: {},
        models: [{ id: 'custom-model', name: 'Custom model', tools: false }],
        allowLocalHttp: false,
      };
      state.backends = [backend];
      if (hasChats) {
        state.chats = [{ sessionId: 'older', model: 'm1', title: 'Older', updatedAt: 1 }];
      }
      const target = backendTargetId(backend, 'custom-model');
      const tree = await mount();
      await selectModel(tree, target);
      expect(tree.root.findByType('ModelSelector' as ElementType).props.value).toBe(target);

      const edited = { ...backend, revision: 2 };
      state.backends = mutation === 'deleted' ? [] : [edited];
      const client = view?.queryClient;
      if (client === undefined) {
        throw new Error('not mounted');
      }
      await act(() => {
        tree.update(createElement(QueryClientProvider, { client }, createElement(ChatListScreen)));
      });

      const selector = tree.root.findByType('ModelSelector' as ElementType);
      expect(selector.props.value).toBe(target);
      expect(offersModel(tree, target)).toBe(false);
      expect(
        tree.root
          .findAllByType('Text' as ElementType)
          .some(node => node.props.children === i18n.t('modelChat.backends.invalidTarget'))
      ).toBe(true);
      if (hasChats) {
        const fab = tree.root.findByProps({ testID: 'chat-new-fab' });
        expect(fab.props.disabled).toBe(true);
        expect(fab.props.accessibilityState).toEqual({ disabled: true, busy: false });
        await pressFab(tree);
      } else {
        expect(startDisabled(tree)).toBe(true);
        await pressStart(tree);
      }
      expect(state.newChat).not.toHaveBeenCalled();
      expect(state.push).not.toHaveBeenCalled();

      // Selecting a current revision (or explicitly choosing Kilo) recovers.
      const current = mutation === 'edited' ? backendTargetId(edited, 'custom-model') : 'm1';
      await selectModel(tree, current);
      if (hasChats) {
        expect(tree.root.findByProps({ testID: 'chat-new-fab' }).props.disabled).toBe(false);
        await pressFab(tree);
      } else {
        expect(startDisabled(tree)).toBe(false);
        await pressStart(tree);
      }
      expect(state.newChat).toHaveBeenCalledExactlyOnceWith(expect.anything(), current);
      expect(state.push).toHaveBeenCalledWith('/(app)/(tabs)/(4_chat)/session-1');
    }
  );
});

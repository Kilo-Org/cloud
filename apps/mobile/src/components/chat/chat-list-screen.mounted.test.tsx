/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as home-screen.mounted.test.tsx) */
import { createElement } from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ChatListScreen } from '@/components/chat/chat-list-screen';
import { renderWithProviders } from '@/test/render-with-providers';

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
}));

vi.mock('@/lib/chat/use-chat', () => ({
  chatPlaceOf: () => ({ chatScope: 'u1:personal', org: { kind: 'personal' } }),
  newChat: state.newChat,
  useChatList: () => ({
    chats: [],
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
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ MessageCircle: 'MessageCircle', Plus: 'Plus' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/chat/chat-row', () => ({ ChatRow: 'ChatRow' }));
vi.mock('@/components/chat/beta-pill', () => ({ BetaPill: 'BetaPill' }));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;

beforeEach(() => {
  vi.clearAllMocks();
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
});

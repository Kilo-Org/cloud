import { createElement, type ElementType, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CenteredState } from '@/components/centered-state';
import { QueryError } from '@/components/query-error';
import { renderWithProviders } from '@/test/render-with-providers';
import { ConversationListScreen } from './conversation-list-screen';
import {
  ConversationHistoryErrorView,
  ConversationInlineRetryBanner,
} from './conversation-history-state-views';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  refresh: vi.fn(),
  refetch: vi.fn<() => void>(),
  create: vi.fn(),
  push: vi.fn(),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  View: 'View',
  Platform: { OS: 'android' },
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: vi.fn() },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }));
vi.mock('@kilocode/kilo-chat-hooks', () => ({
  useBotStatus: vi.fn(),
  useEventServiceClient: vi.fn(),
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-localization', () => ({ getCalendars: () => [{ firstWeekday: 1 }] }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/icons', () => ({
  Plus: 'Plus',
  Settings2: 'Settings2',
  MessageSquarePlus: 'MessageSquarePlus',
  AlertCircle: 'AlertCircle',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));
vi.mock('@/lib/hooks/use-manual-refresh', () => ({
  useManualRefresh: () => [false, mocks.refresh],
}));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  CONVERSATION_CREATED_EVENT: 'created',
}));
vi.mock('./conversation-row', () => ({ ConversationRow: 'ConversationRow' }));
vi.mock('./conversation-header', () => ({ ConversationHeader: 'ConversationHeader' }));
vi.mock('./app-aware-keyboard-padding', () => ({ AppAwareKeyboardPaddingView: 'KeyboardPadding' }));
vi.mock('./hooks/use-kilo-chat-client', () => ({ useKiloChatClient: vi.fn() }));
vi.mock('./hooks/use-instance-presence', () => ({ useInstancePresence: vi.fn() }));
vi.mock('./hooks/use-app-active-and-focused', () => ({ useAppActiveAndFocused: () => true }));
vi.mock('./hooks/use-now-ticker', () => ({ useNowTicker: () => 1_800_000_000_000 }));
vi.mock('./hooks/use-conversations', () => ({
  useConversations: mocks.list,
  useCreateConversation: () => ({ mutate: mocks.create, isPending: false }),
  useLeaveConversation: () => ({ mutate: vi.fn() }),
}));

const mounted: Awaited<ReturnType<typeof renderWithProviders>>[] = [];
async function mountList() {
  const result = await renderWithProviders(
    createElement(ConversationListScreen, { sandboxId: 'instance-1', sandboxLabel: 'Assistant' })
  );
  mounted.push(result);
  return result.renderer.root;
}

function press(node: { props: unknown }) {
  (node.props as { onPress: () => void }).onPress();
}

function refresh(node: { props: unknown }) {
  const { refreshControl } = node.props as {
    refreshControl: ReactElement<{ onRefresh: () => void }>;
  };
  refreshControl.props.onRefresh();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockReturnValue({
    data: { conversations: [] },
    isPending: false,
    isError: false,
    refetch: mocks.refetch,
    hasNextPage: false,
    isFetchingNextPage: false,
  });
});

afterEach(() => {
  for (const result of mounted.splice(0)) {
    result.unmount();
  }
});

describe('Kilo Chat full-body states', () => {
  it('centers the empty list outside FlashList and preserves refresh and creation', async () => {
    const root = await mountList();
    expect(root.findAllByType('FlashList' as ElementType)).toHaveLength(0);
    const centered = root.findByType(CenteredState);
    refresh(centered);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    press(root.findByType('Button' as ElementType));
    expect(mocks.create).toHaveBeenCalledWith({ sandboxId: 'instance-1' }, expect.any(Object));
    expect(root.findAllByType('Plus' as ElementType)).toHaveLength(0);
    expect(root.findAllByType('ScreenHeader' as ElementType)).toHaveLength(1);
  });

  it('keeps loaded conversations in FlashList with refresh and one creation button', async () => {
    mocks.list.mockReturnValue({
      data: { conversations: [{ conversationId: 'conversation-1', joinedAt: 1_800_000_000_000 }] },
      isPending: false,
      isError: false,
      refetch: mocks.refetch,
    });
    const root = await mountList();
    expect(root.findAllByType(CenteredState)).toHaveLength(0);
    const list = root.findByType('FlashList' as ElementType);
    expect(list.props.ListEmptyComponent).toBeUndefined();
    refresh(list);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(root.findAllByType('Plus' as ElementType)).toHaveLength(1);
  });

  it('centers list failures without rendering the empty-list creation action', async () => {
    mocks.list.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      refetch: mocks.refetch,
    });
    const root = await mountList();
    expect(root.findAllByType(CenteredState)).toHaveLength(1);
    expect(root.findAllByType('FlashList' as ElementType)).toHaveLength(0);
    expect(root.findAllByType(QueryError)).toHaveLength(1);
    press(root.findByType('Button' as ElementType));
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('centers initial-history errors but keeps retained-history errors inline', async () => {
    const error = await renderWithProviders(
      createElement(ConversationHistoryErrorView, { onRetry: mocks.refetch })
    );
    mounted.push(error);
    expect(error.renderer.root.findAllByType(CenteredState)).toHaveLength(1);
    const inline = await renderWithProviders(
      createElement(ConversationInlineRetryBanner, { message: 'Retry', onRetry: mocks.refetch })
    );
    mounted.push(inline);
    expect(inline.renderer.root.findAllByType(CenteredState)).toHaveLength(0);
    press(inline.renderer.root.findByType('Pressable' as ElementType));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});

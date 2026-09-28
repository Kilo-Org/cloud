// Mounted coverage for the chat screen's keyboard lift. The composer's own
// bottom padding already includes the platform's safe-area inset
// (`resolveMessageInputBottomPadding`), so the screen's
// `AppAwareKeyboardPaddingView` must not count that inset a second time: doing
// so floated the composer a navigation-bar height above the keyboard on Android
// (2026-09-21 review finding). Both platforms are asserted against the metric
// the composer completes, so a caller that drops the opt-in fails here.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';
import { ConversationScreen } from './conversation-screen';

const platform = vi.hoisted(() => ({ OS: 'android' }));
const insets = vi.hoisted(() => ({ bottom: 0 }));
const keyboard = vi.hoisted(() => ({
  show: null as ((event: { endCoordinates: { height: number } }) => void) | null,
  hide: null as (() => void) | null,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: platform,
  Keyboard: {
    addListener: vi.fn((event: string, listener: (event?: unknown) => void) => {
      if (event === 'keyboardDidShow' || event === 'keyboardWillShow') {
        keyboard.show = listener as (event: { endCoordinates: { height: number } }) => void;
      }
      if (event === 'keyboardDidHide' || event === 'keyboardWillHide') {
        keyboard.hide = listener as () => void;
      }
      return { remove: vi.fn() };
    }),
  },
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets,
}));

vi.mock('@kilocode/kilo-chat-hooks', () => ({
  useBotStatus: () => null,
  useEventServiceClient: () => ({}),
}));

vi.mock('@kilocode/kilo-chat', () => ({ CONVERSATION_TITLE_MAX_CHARS: 100 }));

vi.mock('expo-router', () => ({
  useFocusEffect: vi.fn(),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('react-i18next', async importOriginal => {
  const actual = (await importOriginal()) as typeof ReactI18next;
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));
vi.mock('@/lib/notifications', () => ({ setActiveChatLocation: vi.fn() }));
vi.mock('@/lib/kilo-chat-routes', () => ({ chatInstancePickerPath: () => '/instances' }));
vi.mock('@/lib/kiloclaw-display', () => ({ kiloclawConversationEyebrow: () => undefined }));
vi.mock('@/lib/hooks/use-instance-context', () => ({
  instanceOrgId: () => 'org-1',
  useInstanceContext: () => ({ status: 'ready' }),
  useAllKiloClawInstances: () => ({ data: undefined }),
}));
vi.mock('@/lib/hooks/use-kiloclaw-queries', () => ({ useKiloClawStatus: () => ({ data: null }) }));

// Mocked like the repo's other mounted screens: the loading/error views and the
// heavy children are stubbed down to their element type, so the mounted tree is
// the screen's own keyboard-lift view and the composer's slot in it. This test
// keeps the history content at `ready`, so none of those views render.
vi.mock('./conversation-history-state-views', () => ({
  ConversationHistoryErrorView: 'ConversationHistoryErrorView',
  ConversationHistoryLoadingView: 'ConversationHistoryLoadingView',
  ConversationInlineRetryBanner: 'ConversationInlineRetryBanner',
}));
vi.mock('./conversation-header', () => ({ ConversationHeader: 'ConversationHeader' }));
vi.mock('./message-list', () => ({ MessageList: 'MessageList' }));
vi.mock('./message-input', () => ({ MessageInput: 'MessageInput' }));
vi.mock('./message-reaction-picker-sheet', () => ({
  MessageReactionPickerSheet: 'MessageReactionPickerSheet',
}));

vi.mock('./kilo-chat-provider', () => ({
  useKiloChatTokenError: () => ({ hasError: false, retry: vi.fn() }),
}));
vi.mock('./hooks/use-app-active-and-focused', () => ({ useAppActiveAndFocused: () => true }));
vi.mock('./hooks/use-current-user-id', () => ({ useCurrentUserId: () => 'user-1' }));
vi.mock('@/lib/hooks/use-now-ticker', () => ({ useNowTicker: () => 1_800_000_000_000 }));
vi.mock('./hooks/use-kilo-chat-client', () => ({ useKiloChatClient: () => ({}) }));
vi.mock('./hooks/use-conversation-presence', () => ({ useConversationPresence: vi.fn() }));
vi.mock('./hooks/use-conversation-event-subscription', () => ({
  useConversationEventSubscription: vi.fn(),
}));
vi.mock('./hooks/use-conversation-mark-read', () => ({ useConversationMarkRead: vi.fn() }));
vi.mock('./hooks/use-messages', () => ({
  useMessageCacheUpdater: vi.fn(),
  useMessages: () => ({
    data: { messages: [] },
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));
vi.mock('./hooks/use-typing', () => ({
  useMobileTypingState: () => ({ typingMembers: [], clearTypingForMember: vi.fn() }),
  useTypingSender: () => vi.fn(),
}));
vi.mock('./hooks/use-conversation-options-sheet', () => ({
  useConversationOptionsSheet: () => ({
    openOptions: vi.fn(),
    renaming: false,
    closeRename: vi.fn(),
    saveRename: vi.fn(),
  }),
}));
vi.mock('./hooks/use-conversation-message-controller', () => ({
  useConversationMessageController: () => ({
    editingMessage: null,
    editingText: '',
    visibleEditingAttachments: [],
    inputAvailability: {
      disabled: false,
      submitDisabled: false,
      disabledReason: undefined,
      showInstanceCta: false,
    },
    pendingAction: null,
    reactionPickerMessage: null,
    recentReactions: [],
    replyingTo: null,
    scrollToNewestRequest: 0,
    handleExecuteAction: vi.fn(),
    handleLongPressMessage: vi.fn(),
    handleReactionPress: vi.fn(),
    handleSend: vi.fn(),
    handleSwipeReplyMessage: vi.fn(),
    setEditingMessage: vi.fn(),
    setRemovedEditAttachmentIds: vi.fn(),
    setReactionPickerMessage: vi.fn(),
    setReplyingTo: vi.fn(),
  }),
}));

function mount() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(ConversationScreen, {
        sandboxId: 'instance-1',
        conversationId: 'conversation-1',
        conversationTitle: 'Title',
        conversationRenameTitle: 'Title',
        conversationMembers: [],
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('conversation screen was not mounted');
  }
  return renderer;
}

/** Padding the screen's keyboard-lift view reserves (its own style slot). */
function keyboardPadding(renderer: TestRenderer.ReactTestRenderer): number {
  const view = renderer.root.find(
    node => String(node.type) === 'View' && Array.isArray(node.props.style)
  );
  const parts = view.props.style as (Record<string, number> | undefined)[];
  const padded = parts.find(part => part != null && 'paddingBottom' in part);
  return padded?.paddingBottom ?? -1;
}

describe('ConversationScreen composer keyboard lift', () => {
  beforeEach(() => {
    platform.OS = 'android';
    insets.bottom = 0;
    keyboard.show = null;
    keyboard.hide = null;
  });

  it("adds only the raw Android metric on top of the composer's own inset padding", () => {
    platform.OS = 'android';
    insets.bottom = 63;
    const renderer = mount();

    act(() => {
      keyboard.show?.({ endCoordinates: { height: 704 } });
    });
    // 767 would be the screen-bottom-anchored occlusion counting the inset the
    // composer already pads by a second time.
    expect(keyboardPadding(renderer)).toBe(704);

    renderer.unmount();
  });

  it('keeps the iOS frame height, which the composer completes', () => {
    platform.OS = 'ios';
    insets.bottom = 34;
    const renderer = mount();

    act(() => {
      keyboard.show?.({ endCoordinates: { height: 300 } });
    });
    expect(keyboardPadding(renderer)).toBe(300);

    renderer.unmount();
  });

  it('reserves nothing while the keyboard is down', () => {
    insets.bottom = 63;
    const renderer = mount();

    expect(keyboardPadding(renderer)).toBe(0);

    renderer.unmount();
  });
});

// Mounted coverage for the chat screen's keyboard lift. The composer's own
// bottom padding already includes the platform's safe-area inset
// (`resolveMessageInputBottomPadding`), so the `KeyboardAvoidingView` that
// wraps the composer reduces its lift by that inset on Android: without the
// correction the composer floated a navigation-bar height above the keyboard
// (2026-09-21 review finding). Both platforms are asserted against the metric
// the composer completes, so a caller that drops the correction fails here.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';
import { ConversationScreen } from './conversation-screen';

const platform = vi.hoisted(() => ({ OS: 'android' }));
const insets = vi.hoisted(() => ({ bottom: 0 }));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: platform,
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

/** The keyboard-lift wrapper the composer rides. */
function liftView(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  return renderer.root.find(node => String(node.type) === 'KeyboardAvoidingView');
}

describe('ConversationScreen composer keyboard lift', () => {
  beforeEach(() => {
    platform.OS = 'android';
    insets.bottom = 0;
  });

  it("reduces the Android lift by the composer's own inset padding", () => {
    platform.OS = 'android';
    insets.bottom = 63;
    const renderer = mount();

    // The composer's own bottom padding already includes the platform's bottom
    // inset (`resolveMessageInputBottomPadding`), so the lift is reduced by it:
    // a negative `keyboardVerticalOffset`. Without the correction the composer
    // floats a navigation-bar height above the keyboard.
    const lift = liftView(renderer);
    expect(lift.props.behavior).toBe('padding');
    expect(lift.props.className).toBe('flex-1');
    expect(lift.props.keyboardVerticalOffset).toBe(-63);

    renderer.unmount();
  });

  it('keeps the iOS frame height, which the composer completes', () => {
    platform.OS = 'ios';
    insets.bottom = 34;
    const renderer = mount();

    // iOS reports the keyboard frame, which stops at the screen bottom, so the
    // lift takes no inset correction here.
    expect(liftView(renderer).props.keyboardVerticalOffset).toBe(0);

    renderer.unmount();
  });

  it('adds no JS keyboard padding of its own while the keyboard is down', () => {
    insets.bottom = 63;
    const renderer = mount();

    // The native lift contributes 0 while the keyboard is down, and the screen
    // keeps no JS padding slot of its own: the wrapper carries no inline style.
    expect(liftView(renderer).props.style).toBeUndefined();

    renderer.unmount();
  });
});

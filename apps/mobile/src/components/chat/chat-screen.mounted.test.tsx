/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ChatScreen } from '@/components/chat/chat-screen';
import { type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * What the chat screen draws while it is opening.
 *
 * Reopening a stored chat is not instant: the Kilo server is read before the
 * history, so the transcript is empty for a moment even though the chat has
 * one. That moment has to read as a loading transcript, and the empty state
 * belongs to a chat that has finished opening and really has nothing in it.
 */

const state = vi.hoisted(() => ({
  status: 'opening' as 'opening' | 'idle' | 'working',
  messages: [] as { info: { id: string } }[],
}));

vi.mock('@/lib/chat/use-chat', () => ({
  chatPlaceOf: () => ({ chatScope: 'u1:personal', org: { kind: 'personal' } }),
  useChat: () => ({
    state: {
      sessionId: 's1',
      model: 'm1',
      turns: [],
      answering: '',
      status: state.status,
      asked: null,
      waiting: [],
      failed: null,
    },
    send: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock('@/lib/chat/turns', () => ({ asMessages: () => state.messages }));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1' }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: [], isLoading: false, isError: false }),
}));
vi.mock('@/lib/hooks/use-session-model-options', () => ({
  useSessionModelOptions: () => ({ options: [] }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: 'black', mutedForeground: 'grey' }),
}));
vi.mock('@/components/agents/chat-composer', () => ({ ChatComposer: 'ChatComposer' }));
vi.mock('@/components/agents/message-bubble', () => ({ MessageBubble: 'MessageBubble' }));
vi.mock('@/components/agents/session-message-list', () => ({
  SessionMessageList: 'SessionMessageList',
}));
vi.mock('@/components/agents/session-keyboard-container-state', () => ({
  getSessionKeyboardContainerKind: () => 'keyboard-avoiding',
}));
vi.mock('@/components/kilo-chat/app-aware-keyboard-padding', () => ({
  AppAwareKeyboardPaddingView: 'AppAwareKeyboardPaddingView',
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/icons', () => ({ MessageCircle: 'MessageCircle', Wrench: 'Wrench' }));
vi.mock('@/components/ui/status-dot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/agents/session-detail-skeleton', () => ({
  SessionSkeletonMessages: 'SessionSkeletonMessages',
}));
vi.mock('@/components/chat/beta-pill', () => ({ BetaPill: 'BetaPill' }));
vi.mock('@/components/chat/mcp-settings-sheet', () => ({
  McpSettingsSheet: 'McpSettingsSheet',
  useMcpSettings: () => ({
    view: {
      enabled: false,
      statusKey: 'modelChat.mcp.off',
      descriptionKey: null,
      toolCount: 0,
      retry: false,
      busy: false,
      tone: 'muted',
    },
    setEnabled: () => undefined,
    retry: () => undefined,
    retrying: false,
  }),
}));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;

beforeEach(() => {
  state.status = 'opening';
  state.messages = [];
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function mount(): Promise<ReactTestRenderer> {
  view = await renderWithProviders(createElement(ChatScreen, { opened: 's1' }));
  return view.renderer;
}

const count = (tree: ReactTestRenderer, type: string): number =>
  tree.root.findAll(node => (node.type as string) === type).length;

describe('the chat transcript while it opens', () => {
  it('shows a loading transcript instead of the empty state', async () => {
    const tree = await mount();

    expect(count(tree, 'EmptyState')).toBe(0);
    expect(count(tree, 'SessionMessageList')).toBe(0);
    expect(count(tree, 'SessionSkeletonMessages')).toBe(1);
  });

  it('shows the empty state once the open has finished with no messages', async () => {
    state.status = 'idle';
    const tree = await mount();

    expect(count(tree, 'EmptyState')).toBe(1);
    expect(count(tree, 'SessionSkeletonMessages')).toBe(0);
  });

  it('shows the stored transcript once the open has finished with messages', async () => {
    state.status = 'idle';
    state.messages = [{ info: { id: 'm-1' } }];
    const tree = await mount();

    expect(count(tree, 'SessionMessageList')).toBe(1);
    expect(count(tree, 'EmptyState')).toBe(0);
    expect(count(tree, 'SessionSkeletonMessages')).toBe(0);
  });
});

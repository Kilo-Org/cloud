/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ChatScreen } from '@/components/chat/chat-screen';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { type StoredChatBackend } from '@/lib/chat/backend-store';
import { backendTargetId } from '@/lib/chat/backend-target';

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

type AlertAction = { onPress?: () => void };
const backendUi = vi.hoisted(() => ({
  profiles: [] as StoredChatBackend[],
  alert: vi.fn<(title: string, message: string, actions?: AlertAction[]) => void>(),
}));

const mcpModel = vi.hoisted(() => ({
  view: {
    enabled: false,
    toggleable: true,
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
  settingsTools: {
    titleKey: 'modelChat.mcp.settingsToolsTitle',
    subtitleKey: 'modelChat.mcp.settingsToolsSubtitle',
    statusKey: 'modelChat.mcp.settingsToolsOff',
    tone: 'muted',
  },
  settingsToolsEnabled: false,
  setSettingsToolsEnabled: () => undefined,
  servers: [],
  storedServers: [],
  setServerEnabled: () => undefined,
  addServer: async () => {
    await Promise.resolve();
    return false;
  },
  updateServer: async () => {
    await Promise.resolve();
    return false;
  },
  deleteServer: async () => {
    await Promise.resolve();
    return false;
  },
  saving: false,
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
vi.mock('@/lib/chat/backend-store', () => ({ useChatBackends: () => backendUi.profiles }));
vi.mock('@/components/chat/backend-settings-sheet', () => ({
  BackendSettingsControl: 'BackendSettingsControl',
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
vi.mock('@/components/ui/icons', () => ({
  MessageCircle: 'MessageCircle',
  Wrench: 'Wrench',
  Server: 'Server',
}));
vi.mock('@/components/ui/status-dot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/agents/session-detail-skeleton', () => ({
  SessionSkeletonMessages: 'SessionSkeletonMessages',
}));
vi.mock('@/components/chat/beta-pill', () => ({ BetaPill: 'BetaPill' }));
vi.mock('@/components/chat/mcp-settings-sheet', () => ({
  McpSettingsSheet: 'McpSettingsSheet',
  useMcpSettings: () => mcpModel,
}));
vi.mock('react-native', () => ({
  Alert: { alert: backendUi.alert },
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
  backendUi.profiles = [];
  backendUi.alert.mockClear();
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

describe('backend context-transfer approval', () => {
  it('requires approval when returning from a picked custom backend before its queued move finishes', async () => {
    state.status = 'working';
    const backend: StoredChatBackend = {
      id: 'backend-one',
      revision: 1,
      name: 'One',
      baseUrl: 'https://one.example/v1',
      apiKind: 'responses',
      apiKey: '',
      headers: {},
      models: [{ id: 'shared', name: 'Shared', tools: false }],
      allowLocalHttp: false,
    };
    backendUi.profiles = [backend];
    const target = backendTargetId(backend, 'shared');
    const tree = await mount();
    const composer = () =>
      tree.root.find(node => (node.type as string) === 'ChatComposer').props as {
        model: string;
        onModelSelect: (model: string, variant: string) => void;
      };
    act(() => {
      composer().onModelSelect(target, '');
    });
    expect(composer().model).toBe('m1');
    act(() => {
      backendUi.alert.mock.calls
        .at(-1)?.[2]
        ?.find(action => action.onPress)
        ?.onPress?.();
    });
    expect(composer().model).toBe(target);
    act(() => {
      composer().onModelSelect('m1', '');
    });
    expect(backendUi.alert).toHaveBeenCalledTimes(2);
    expect(composer().model).toBe(target);
  });
});

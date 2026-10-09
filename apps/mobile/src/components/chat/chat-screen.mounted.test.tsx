/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/render-with-providers.tsx) */
/* eslint-disable max-lines -- the screen's states share one mounted fixture: opening, backend approval, failure, and message actions. */
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
  messages: [] as { info: { id: string; role?: string } }[],
  asked: null as string | null,
  failed: null as string | null,
  failureKey: null as string | null,
  retry: vi.fn(),
  send: vi.fn(),
  model: 'm1',
}));

type AlertAction = { onPress?: () => void };
const backendUi = vi.hoisted(() => ({
  profiles: [] as StoredChatBackend[],
  loaded: true,
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
      model: state.model,
      turns: [],
      answering: '',
      status: state.status,
      asked: state.asked,
      waiting: [],
      failed: state.failed,
      failureKey: state.failureKey,
    },
    send: state.send,
    stop: vi.fn(),
    retry: state.retry,
  }),
}));
vi.mock('@/lib/chat/turns', () => ({
  asMessages: () => state.messages,
  askedMessageId: (sessionId: string) => `${sessionId}:asked`,
}));
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
vi.mock('@/lib/chat/backend-store', () => ({
  useChatBackends: () => backendUi.profiles,
  getChatBackendsHasLoaded: () => backendUi.loaded,
}));
vi.mock('@/lib/chat/local-models', () => ({ useLocalModels: () => [] }));
vi.mock('@/lib/chat/gguf-models', () => ({
  useGgufModels: () => ({ models: [], download: null, failure: null }),
  ggufModelOptions: () => [],
}));
vi.mock('@/components/chat/backend-settings-sheet', () => ({
  BackendSettingsControl: 'BackendSettingsControl',
}));
vi.mock('@/components/agents/chat-composer', () => ({ ChatComposer: 'ChatComposer' }));
vi.mock('@/components/agents/message-bubble', () => ({ MessageBubble: 'MessageBubble' }));
vi.mock('@/components/agents/message-details-sheet', () => ({
  MessageDetailsSheet: 'MessageDetailsSheet',
}));
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
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
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
  state.asked = null;
  state.failed = null;
  state.failureKey = null;
  state.retry.mockClear();
  backendUi.profiles = [];
  backendUi.alert.mockClear();
  backendUi.loaded = true;
  state.model = 'm1';
  state.send.mockClear();
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

function isHandler(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

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

  it('hands the sheet the whole chat-tools model', async () => {
    const tree = await mount();
    const sheet = tree.root.findAll(node => (node.type as string) === 'McpSettingsSheet')[0];

    expect(sheet?.props.settings).toBe(mcpModel);
    expect(sheet?.props.visible).toBe(false);
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

describe('sending before stored backends load', () => {
  it('does not report a stored custom target as deleted', async () => {
    state.status = 'idle';
    backendUi.loaded = false;
    state.model = 'backend:server:1:model';
    const tree = await mount();
    const { onSend } = tree.root.find(node => (node.type as string) === 'ChatComposer').props;
    if (!isHandler(onSend)) {
      throw new TypeError('Composer has no send handler');
    }
    act(() => {
      onSend('Question');
    });
    expect(backendUi.alert).not.toHaveBeenCalled();
    expect(state.send).toHaveBeenCalledWith('Question', 'backend:server:1:model');
  });
});

describe('a retained chat failure', () => {
  it('shows only fixed copy and retries the retained work', async () => {
    state.status = 'idle';
    state.failed = 'Bearer provider-secret from a raw provider body';
    state.failureKey = 'modelChat.backends.deletedBackend';
    const tree = await mount();
    const status = tree.root.find(node => (node.type as string) === 'AccessibleStatus');
    expect(status.props.message).toBe(
      'This chat backend was deleted. Choose another backend to continue.'
    );
    expect(
      tree.root.findAll(node =>
        Object.values(node.props).some(
          value => typeof value === 'string' && value.includes('provider-secret')
        )
      )
    ).toHaveLength(0);
    const { onPress } = tree.root.find(node => (node.type as string) === 'Button').props;
    if (!isHandler(onPress)) {
      throw new TypeError('Retry button has no press handler');
    }
    act(() => {
      onPress();
    });
    expect(state.retry).toHaveBeenCalledOnce();
  });
});

type BubbleProps = {
  onLongPressDetails?: (message: unknown) => void;
  deliveryState?: { status: string; error?: string; reason?: string };
  onRetryMessage?: (message: unknown) => void;
  onCopyToComposer?: (text: string) => void;
};

type RenderItem = (info: { item: unknown; index: number }) => { props: BubbleProps };

/** The props the transcript hands the bubble of one message. */
function bubbleFor(tree: ReactTestRenderer, id: string): BubbleProps {
  const list = tree.root.find(node => (node.type as string) === 'SessionMessageList');
  const renderItem = list.props.renderItem as RenderItem;
  const item = state.messages.find(message => message.info.id === id);
  if (item === undefined) {
    throw new TypeError(`No message ${id}`);
  }
  return renderItem({ item, index: 0 }).props;
}

const sheetOf = (tree: ReactTestRenderer) =>
  tree.root.find(node => (node.type as string) === 'MessageDetailsSheet').props as {
    visible: boolean;
    message: unknown;
    deliveryState?: unknown;
    onClose: () => void;
  };

describe('message actions', () => {
  it('opens the details of a question and of an answer on long-press', async () => {
    state.status = 'idle';
    state.messages = [
      { info: { id: 't1', role: 'user' } },
      { info: { id: 't2', role: 'assistant' } },
    ];
    const tree = await mount();
    expect(sheetOf(tree).visible).toBe(false);

    for (const message of state.messages) {
      act(() => {
        bubbleFor(tree, message.info.id).onLongPressDetails?.(message);
      });
      expect(sheetOf(tree)).toMatchObject({ visible: true, message });
      act(() => {
        sheetOf(tree).onClose();
      });
      expect(sheetOf(tree).visible).toBe(false);
    }
  });

  it('puts Retry and Copy to composer on the failed question, and states why under the transcript', async () => {
    state.status = 'idle';
    state.asked = 'what is a monad';
    state.failureKey = 'modelChat.backends.deletedBackend';
    state.messages = [
      { info: { id: 't1', role: 'user' } },
      { info: { id: 's1:asked', role: 'user' } },
      // Typed while the answer failed: it waits under the question.
      { info: { id: 's1:waiting:0', role: 'user' } },
    ];
    const tree = await mount();
    const failed = bubbleFor(tree, 's1:asked');

    expect(failed.deliveryState).toEqual({ status: 'failed', error: '', reason: 'execution' });
    expect(bubbleFor(tree, 's1:waiting:0').onRetryMessage).toBeUndefined();
    expect(bubbleFor(tree, 't1').deliveryState).toBeUndefined();
    expect(tree.root.find(node => (node.type as string) === 'AccessibleStatus').props.message).toBe(
      'This chat backend was deleted. Choose another backend to continue.'
    );
    // The message carries the one Retry.
    expect(count(tree, 'Button')).toBe(0);

    act(() => {
      failed.onRetryMessage?.(state.messages[1]);
    });
    expect(state.retry).toHaveBeenCalledOnce();

    const setText = vi.fn();
    const composer = tree.root.find(node => (node.type as string) === 'ChatComposer');
    const controlRef = composer.props.controlRef as { current: unknown };
    controlRef.current = { setText, hasContent: () => false, restoreAttachments: () => undefined };
    act(() => {
      failed.onCopyToComposer?.('what is a monad');
    });
    expect(setText).toHaveBeenCalledWith('what is a monad');

    act(() => {
      failed.onLongPressDetails?.(state.messages[1]);
    });
    expect(sheetOf(tree).deliveryState).toEqual(failed.deliveryState);
  });

  it('reads a question with no failure as stopped, with no row under the transcript', async () => {
    state.status = 'idle';
    state.asked = 'what is a monad';
    state.messages = [{ info: { id: 's1:asked', role: 'user' } }];
    const tree = await mount();

    expect(bubbleFor(tree, 's1:asked').deliveryState).toMatchObject({ reason: 'interrupted' });
    expect(count(tree, 'AccessibleStatus')).toBe(0);
  });

  it('offers no Retry while the question is still being answered', async () => {
    state.status = 'working';
    state.asked = 'what is a monad';
    state.messages = [{ info: { id: 's1:asked', role: 'user' } }];
    const tree = await mount();

    expect(bubbleFor(tree, 's1:asked').onRetryMessage).toBeUndefined();
  });
});

/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */
/* eslint-disable max-lines -- the mounted screen contract shares one mock harness across the state tests */

// Quick-chat screen contract: an empty composer always renders, a send accept
// puts a user bubble into the transcript, a first history failure with no rows
// shows Retry (a permanent code shows none), a refetch failure keeps existing
// rows with an inline retry, and a missing or failed model catalog never
// disables the composer. A failed catalog with no rows shows the catalog
// QueryError, not the happy empty copy; its compact retry only appears once
// rows exist and names the failure for screen readers. Four-state coverage adds
// the assistant reply after a stream (happy), the stream-failure-after-accept
// outcome, the empty copy, and the flag-off replace to Home. The hook also must
// not fetch history, create a thread, or accept a send before the org scope
// hydrates (showing the skeleton, not EmptyState), and a send must abort an
// in-flight stream.

import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TabsLayout from '@/app/(app)/(tabs)/_layout';
import { i18n } from '@/i18n';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import { QuickChatScreen } from './quick-chat-screen';

const listMessagesQueryFn = vi.hoisted(() => vi.fn());
const getOrCreateThreadMutate = vi.hoisted(() => vi.fn());
const listMessagesQuery = vi.hoisted(() => vi.fn());
const appendMessagesMutate = vi.hoisted(() => vi.fn());
const streamMock = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const routerNavigate = vi.hoisted(() => vi.fn());

const modelsState = vi.hoisted(() => ({
  models: [] as { id: string; name: string; variants: string[]; isPreferred: boolean }[],
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));

const modelOptionsState = vi.hoisted(() => ({
  options: [] as {
    id: string;
    name: string;
    displayId: string;
    variants: string[];
    isPreferred: boolean;
  }[],
  selectedValue: '',
  selectedVariant: '',
}));

const composerRenders = vi.hoisted(() => ({ list: [] as Record<string, unknown>[] }));
const sessionListRenders = vi.hoisted(() => ({ list: [] as Record<string, unknown>[] }));
const queryErrors = vi.hoisted(() => ({ list: [] as Record<string, unknown>[] }));
const buttonRenders = vi.hoisted(() => ({
  list: [] as { onPress?: () => void; accessibilityLabel?: string }[],
}));
const emptyStateRenders = vi.hoisted(() => ({ list: [] as { title?: string }[] }));
const skeletonRenders = vi.hoisted(() => ({ count: 0 }));

// Feature-flag / router / org-hydration knobs shared by the flag-gate and
// org-loading tests.
const quickChatFlagEnabled = vi.hoisted(() => ({ value: true }));
const kiloclawVisible = vi.hoisted(() => ({ value: false }));
const focusedSegments = vi.hoisted(() => ({ value: ['(app)', '(tabs)', '(0_home)'] }));
const orgLoaded = vi.hoisted(() => ({ value: true }));
const organizationId = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('react-native', () => ({
  View: 'View',
  Keyboard: { addListener: () => ({ remove: vi.fn() }) },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ fontScale: 1, width: 0, height: 0 }),
}));
vi.mock('sonner-native', () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn() },
}));
vi.mock('expo-router', () => {
  const Tabs = Object.assign(() => null, { Screen: () => null });
  return {
    useRouter: () => ({ replace: routerReplace, navigate: routerNavigate, push: routerNavigate }),
    usePathname: () => '/(app)/(tabs)/(0_home)',
    useSegments: () => focusedSegments.value,
    Tabs,
  };
});
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 }),
}));

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  parseTimestamp: (value: string) => new Date(value),
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ authEpoch: 0, token: 'token' }),
}));
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: () => 'token-1',
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: organizationId.value, isLoaded: orgLoaded.value }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({
    userId: 'u-1',
    email: null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ settled: true, value: null }),
}));
vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_QUICK_CHAT: 'mobile-quick-chat',
  useFeatureFlag: () => quickChatFlagEnabled.value,
}));
vi.mock('@/lib/hooks/use-kiloclaw-tab-visible', () => ({
  useKiloClawTabVisible: () => kiloclawVisible.value,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#888888' }),
}));
vi.mock('@/lib/finding-detail-back', () => ({
  PROFILE_TAB_ROOT: '/(app)/(tabs)/(3_profile)',
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    quickChat: {
      listMessages: {
        queryOptions: (input: unknown) => ({
          queryKey: ['quickChat.listMessages', input],
          queryFn: () => listMessagesQueryFn(input),
        }),
      },
    },
  }),
  trpcClient: {
    quickChat: {
      getOrCreateThread: { mutate: getOrCreateThreadMutate },
      listMessages: { query: listMessagesQuery },
      appendMessages: { mutate: appendMessagesMutate },
    },
  },
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({
    models: modelsState.models,
    isLoading: modelsState.isLoading,
    isError: modelsState.isError,
    error: null,
    refetch: modelsState.refetch,
  }),
}));
vi.mock('@/lib/hooks/use-session-model-options', () => ({
  useSessionModelOptions: () => ({
    source: 'cloud-agent-gateway',
    options: modelOptionsState.options,
    selectedValue: modelOptionsState.selectedValue,
    selectedVariant: modelOptionsState.selectedVariant,
    pickerDisabled: false,
    isLoading: false,
  }),
}));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));
vi.mock('@/components/agents/session-keyboard-container-state', () => ({
  getSessionKeyboardContainerKind: () => 'keyboard-avoiding',
}));
vi.mock('@/components/kilo-chat/app-aware-keyboard-padding', () => ({
  AppAwareKeyboardPaddingView: 'AppAwareKeyboardPaddingView',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/agents/session-detail-skeleton', () => ({
  SessionSkeletonMessages: () => {
    skeletonRenders.count += 1;
    return null;
  },
}));
vi.mock('@/components/ui/blur-bar', () => ({ BlurBar: 'BlurBar' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  House: 'House',
  MessageCircle: 'MessageCircle',
  MessageSquare: 'MessageSquare',
  UserRound: 'UserRound',
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title?: string }) => {
    emptyStateRenders.list.push({ title });
    return null;
  },
}));
vi.mock('@/components/query-error', () => ({
  QueryError: (props: Record<string, unknown>) => {
    queryErrors.list.push(props);
    return null;
  },
}));
vi.mock('@/components/ui/button', () => ({
  Button: (props: { onPress?: () => void; accessibilityLabel?: string; children?: unknown }) => {
    buttonRenders.list.push(props);
    return createElement('View', null, props.children);
  },
}));
vi.mock('@/components/agents/session-message-list', () => ({
  SessionMessageList: (props: Record<string, unknown>) => {
    sessionListRenders.list.push(props);
    return null;
  },
}));
vi.mock('@/components/agents/message-bubble', () => ({
  MessageBubble: () => null,
}));
vi.mock('@/components/agents/chat-composer', () => ({
  ChatComposer: (props: Record<string, unknown>) => {
    composerRenders.list.push(props);
    return null;
  },
}));
vi.mock('./quick-chat-gateway', () => ({
  streamQuickChatCompletion: streamMock,
}));

type RenderedMessage = { info: { role: string }; parts: { text?: string }[] };

const modelOption = {
  id: 'm1',
  name: 'Model 1',
  displayId: 'm1',
  variants: [],
  isPreferred: false,
};

const secondModelOption = {
  id: 'm2',
  name: 'Model 2',
  displayId: 'm2',
  variants: [],
  isPreferred: false,
};

/** A stream that never completes on its own: the hook's abort must end it. */
async function* hangingStream(): AsyncGenerator<string> {
  await new Promise<void>(() => undefined);
  yield '';
}

function transcriptItems(): RenderedMessage[] {
  const latest = sessionListRenders.list.at(-1);
  return (latest?.items as RenderedMessage[] | undefined) ?? [];
}

function latestComposer(): Record<string, unknown> | undefined {
  return composerRenders.list.at(-1);
}

async function mountScreen() {
  const result = await renderWithProviders(createElement(QuickChatScreen));
  return result;
}

function pressSend(text: string): void {
  const onSend = latestComposer()?.onSend as ((text: string) => void) | undefined;
  onSend?.(text);
}

beforeEach(() => {
  listMessagesQueryFn.mockReset();
  getOrCreateThreadMutate.mockReset();
  listMessagesQuery.mockReset();
  appendMessagesMutate.mockReset();
  streamMock.mockReset();
  toastError.mockReset();
  routerReplace.mockReset();
  routerNavigate.mockReset();
  modelsState.models = [];
  modelsState.isLoading = false;
  modelsState.isError = false;
  modelsState.refetch.mockClear();
  modelOptionsState.options = [];
  modelOptionsState.selectedValue = '';
  modelOptionsState.selectedVariant = '';
  composerRenders.list = [];
  sessionListRenders.list = [];
  queryErrors.list = [];
  buttonRenders.list = [];
  emptyStateRenders.list = [];
  skeletonRenders.count = 0;
  quickChatFlagEnabled.value = true;
  kiloclawVisible.value = false;
  focusedSegments.value = ['(app)', '(tabs)', '(0_home)'];
  orgLoaded.value = true;
  organizationId.value = null;

  getOrCreateThreadMutate.mockResolvedValue({
    id: 'thread-1',
    organizationId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
  });
  listMessagesQueryFn.mockResolvedValue({ messages: [], nextCursor: null });
  listMessagesQuery.mockResolvedValue({ messages: [], nextCursor: null });
  appendMessagesMutate.mockResolvedValue([]);
  streamMock.mockReturnValue([]);
});

describe('QuickChatScreen composer', () => {
  it('renders the composer with the quick-chat placeholder even when empty', async () => {
    await mountScreen();
    await waitFor(() => composerRenders.list.length > 0);

    const composer = latestComposer();
    expect(composer?.placeholder).toBe('Message');
    expect(composer?.attachmentsEnabled).toBe(false);
  });

  it('does not disable the composer when the model catalog is empty', async () => {
    modelOptionsState.options = [];

    await mountScreen();
    await waitFor(() => composerRenders.list.length > 0);

    expect(latestComposer()?.disabled).toBeUndefined();
  });

  it('keeps the composer enabled when the catalog errors', async () => {
    modelsState.isError = true;

    await mountScreen();
    await waitFor(() => composerRenders.list.length > 0);

    expect(latestComposer()?.disabled).toBeUndefined();
    expect(latestComposer()?.model).toBe('');
  });

  it('shows the catalog QueryError when the catalog errors with an empty transcript', async () => {
    modelsState.isError = true;

    await mountScreen();
    await waitFor(() => queryErrors.list.length > 0);

    expect(latestComposer()?.disabled).toBeUndefined();
    const error = queryErrors.list[0];
    expect(error?.variant).toBe('server');
    expect(error?.title).toBe(i18n.t('quickChat.catalogRetry'));
    expect(error?.onRetry).toBeDefined();
    expect(emptyStateRenders.list).toHaveLength(0);
  });
});

describe('QuickChatScreen send', () => {
  it('shows a user bubble after an accepted send', async () => {
    modelOptionsState.options = [modelOption];

    await mountScreen();
    await waitFor(() => composerRenders.list.length > 0);

    await act(async () => {
      pressSend('hello');
      await Promise.resolve();
    });

    const items = transcriptItems();
    expect(items.some(item => item.info.role === 'user' && item.parts[0]?.text === 'hello')).toBe(
      true
    );
  });

  it('does not send when no model is available and toasts instead', async () => {
    modelOptionsState.options = [];

    await mountScreen();
    await waitFor(() => composerRenders.list.length > 0);

    await act(async () => {
      expect(() => {
        pressSend('hello');
      }).toThrow();
      await Promise.resolve();
    });

    expect(toastError).toHaveBeenCalledWith('Could not load models');
    expect(transcriptItems()).toHaveLength(0);
  });

  it('shows assistant text after a completed stream', async () => {
    modelOptionsState.options = [modelOption];
    streamMock.mockImplementation(async function* assistantStream() {
      await Promise.resolve();
      yield 'Hi';
      yield ' there';
    });

    await mountScreen();
    await waitFor(() => composerRenders.list.length > 0);

    await act(async () => {
      pressSend('hello');
      await Promise.resolve();
    });

    await waitFor(() =>
      transcriptItems().some(
        item => item.info.role === 'assistant' && item.parts[0]?.text === 'Hi there'
      )
    );
  });

  it('keeps the user bubble, toasts, and leaves the draft cleared when the stream fails', async () => {
    modelOptionsState.options = [modelOption];
    streamMock.mockImplementation(() => {
      throw new Error('stream boom');
    });

    await mountScreen();
    await waitFor(() => composerRenders.list.length > 0);

    await act(async () => {
      pressSend('hello');
      await Promise.resolve();
    });

    await waitFor(() => toastError.mock.calls.length > 0);
    await waitFor(() => latestComposer()?.isStreaming === false);

    expect(toastError).toHaveBeenCalledWith(i18n.t('quickChat.sendError'));
    const userBubbles = transcriptItems().filter(item => item.info.role === 'user');
    expect(userBubbles).toHaveLength(1);
    expect(userBubbles[0]?.parts[0]?.text).toBe('hello');
    expect(transcriptItems().some(item => item.info.role === 'assistant')).toBe(false);
  });

  it('aborts the in-flight stream when a second send starts', async () => {
    modelOptionsState.options = [modelOption];

    const firstSignal = { value: undefined as AbortSignal | undefined };
    streamMock.mockImplementationOnce((input: { signal?: AbortSignal }) => {
      firstSignal.value = input.signal;
      return hangingStream();
    });

    await mountScreen();
    await waitFor(() => composerRenders.list.length > 0);

    await act(async () => {
      pressSend('first');
      await Promise.resolve();
    });

    expect(firstSignal.value?.aborted).toBe(false);

    await act(async () => {
      pressSend('second');
      await Promise.resolve();
    });

    expect(firstSignal.value?.aborted).toBe(true);
  });

  it('onStop aborts the in-flight completion', async () => {
    modelOptionsState.options = [modelOption];

    const streamSignal = { value: undefined as AbortSignal | undefined };
    streamMock.mockImplementation((input: { signal?: AbortSignal }) => {
      streamSignal.value = input.signal;
      return hangingStream();
    });

    await mountScreen();
    await waitFor(() => composerRenders.list.length > 0);

    await act(async () => {
      pressSend('hello');
      await Promise.resolve();
    });

    expect(streamSignal.value?.aborted).toBe(false);

    await act(async () => {
      const onStop = latestComposer()?.onStop as (() => void) | undefined;
      onStop?.();
      await Promise.resolve();
    });

    expect(streamSignal.value?.aborted).toBe(true);
  });
});

describe('QuickChatScreen history errors', () => {
  it('shows Retry for a first transient history failure with no rows', async () => {
    listMessagesQueryFn.mockRejectedValue(
      Object.assign(new Error('boom'), { data: { code: 'INTERNAL_SERVER_ERROR' } })
    );

    await mountScreen();
    await waitFor(() => queryErrors.list.length > 0);

    const error = queryErrors.list[0];
    expect(error?.variant).toBe('server');
    expect(error?.onRetry).toBeDefined();
  });

  it('shows no Retry for a permanent (NOT_FOUND) history failure', async () => {
    listMessagesQueryFn.mockRejectedValue(
      Object.assign(new Error('missing'), { data: { code: 'NOT_FOUND' } })
    );

    await mountScreen();
    await waitFor(() => queryErrors.list.length > 0);

    const error = queryErrors.list[0];
    expect(error?.variant).toBe('not-found');
    expect(error?.onRetry).toBeUndefined();
  });

  it('keeps rows and offers a compact retry when a later refetch fails', async () => {
    listMessagesQueryFn.mockResolvedValueOnce({
      messages: [
        {
          id: 's1',
          role: 'user',
          content: 'kept',
          createdAt: '2024-01-01T00:00:00.000Z',
          clientId: null,
        },
      ],
      nextCursor: null,
    });

    const { queryClient } = await mountScreen();
    await waitFor(() => transcriptItems().length > 0);

    listMessagesQueryFn.mockRejectedValue(
      Object.assign(new Error('boom'), { data: { code: 'INTERNAL_SERVER_ERROR' } })
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['quickChat.listMessages'] });
    });
    await waitFor(() => buttonRenders.list.length > 0);

    expect(
      transcriptItems().some(item => item.info.role === 'user' && item.parts[0]?.text === 'kept')
    ).toBe(true);
    expect(buttonRenders.list.length).toBeGreaterThan(0);
    const retryButton = buttonRenders.list.find(button => typeof button.onPress === 'function');
    expect(retryButton?.accessibilityLabel).toBe(i18n.t('quickChat.historyRetry'));
  });
});

describe('QuickChatScreen empty state', () => {
  it('renders the empty copy when there are no messages and no error', async () => {
    await mountScreen();
    await waitFor(() => emptyStateRenders.list.length > 0);

    expect(
      emptyStateRenders.list.some(render => render.title === i18n.t('quickChat.empty.title'))
    ).toBe(true);
  });
});

describe('QuickChatScreen org hydration', () => {
  it('does not fetch history until the organization scope is loaded', async () => {
    orgLoaded.value = false;

    await mountScreen();

    expect(listMessagesQueryFn).not.toHaveBeenCalled();
  });

  it('shows the skeleton, not EmptyState, and rejects a send until the org scope is loaded', async () => {
    orgLoaded.value = false;

    await mountScreen();
    await waitFor(() => composerRenders.list.length > 0);

    expect(skeletonRenders.count).toBeGreaterThan(0);
    expect(emptyStateRenders.list).toHaveLength(0);

    await act(async () => {
      expect(() => {
        pressSend('hello');
      }).toThrow('Organization scope not loaded');
      await Promise.resolve();
    });

    expect(getOrCreateThreadMutate).not.toHaveBeenCalled();
    expect(listMessagesQueryFn).not.toHaveBeenCalled();
    expect(appendMessagesMutate).not.toHaveBeenCalled();
    expect(streamMock).not.toHaveBeenCalled();
    expect(transcriptItems()).toHaveLength(0);
  });

  it('resets the picked model to the new catalog default when the org scope changes', async () => {
    modelOptionsState.options = [modelOption, secondModelOption];
    organizationId.value = 'org-1';

    const { renderer, queryClient } = await mountScreen();
    await waitFor(() => composerRenders.list.length > 0);

    // Pick a non-default model through the composer's model select handler.
    await act(async () => {
      const onModelSelect = latestComposer()?.onModelSelect as
        | ((modelId: string, variantId: string) => void)
        | undefined;
      onModelSelect?.('m2', 'v2');
      await Promise.resolve();
    });

    expect(latestComposer()?.model).toBe('m2');

    // Switch the org scope; the composer remounts and the picked model must fall
    // back to the new catalog default, not the stale prior id.
    await act(async () => {
      organizationId.value = 'org-2';
      renderer.update(
        createElement(QueryClientProvider, { client: queryClient }, createElement(QuickChatScreen))
      );
      await Promise.resolve();
    });

    await waitFor(() => latestComposer()?.model === 'm1');
    expect(latestComposer()?.model).toBe('m1');
    expect(latestComposer()?.variant).toBe('');
  });
});

describe('QuickChat flag gate', () => {
  it('replaces to Home when the flag is off while the Chat tab is focused', async () => {
    quickChatFlagEnabled.value = false;
    focusedSegments.value = ['(app)', '(tabs)', '(4_chat)'];

    await renderWithProviders(createElement(TabsLayout));

    expect(routerReplace).toHaveBeenCalledWith('/(app)/(tabs)/(0_home)');
  });
});

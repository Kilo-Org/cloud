import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { type Mock, vi } from 'vitest';

import { i18n } from '@/i18n';

import { SessionPreviewOverlay } from './session-preview-overlay';
import {
  closeSessionPreviewStore,
  getSessionPreviewSnapshot,
  openSessionPreviewStore,
  releaseSessionPreviewStore,
  type SessionPreviewTarget,
} from './session-preview-state';

type TestMessage = { info: { id: string }; parts: readonly never[] };

type TranscriptState = {
  data: { messages: readonly TestMessage[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { data: { code: string } } | null;
  refetch: Mock<() => void>;
};

type LiveRowState = {
  data:
    | {
        status: string | null;
        status_updated_at: string | null;
        total_cost_microdollars: number | null;
      }
    | undefined;
};

/** Controllable query results plus the spies the Alert-backed paths use. */
const holder = vi.hoisted(
  (): {
    transcript: TranscriptState;
    row: LiveRowState;
    platformOS: 'ios' | 'android';
    alert: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    announceForA11y: ReturnType<typeof vi.fn>;
    moveA11yFocus: ReturnType<typeof vi.fn>;
    /**
     * Whether the focus helper was handed a live node *at call time*. Reading
     * the `RefObject` after the test would show the node that mounted later,
     * which is exactly what hid the portal-timing bug.
     */
    focusMoveHadNode: boolean[];
  } => {
    const focusMoveHadNode: boolean[] = [];
    return {
      transcript: {
        data: undefined,
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn<() => void>(),
      },
      row: { data: undefined },
      platformOS: 'ios',
      alert: vi.fn(),
      prompt: vi.fn(),
      announceForA11y: vi.fn(),
      focusMoveHadNode,
      moveA11yFocus: vi.fn((ref: { current: unknown } | undefined): boolean => {
        const hadNode = ref?.current != null;
        focusMoveHadNode.push(hadNode);
        return hadNode;
      }),
    };
  }
);

// A separate binding: vitest refuses to export the `vi.hoisted` declaration
// itself, and the mock factories below close over `holder` lazily.
export const previewState = holder;

// The panel/overlay reads two queries; the key set by the tRPC mock below is
// what tells them apart, so one controllable hook state serves both.
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: readonly string[] }) =>
    options.queryKey[0] === 'session-row' ? holder.row : holder.transcript,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      getSessionMessages: {
        queryOptions: (input: { session_id: string }) => ({
          queryKey: ['transcript', input.session_id],
        }),
      },
      get: {
        queryOptions: (input: { session_id: string }) => ({
          queryKey: ['session-row', input.session_id],
        }),
      },
    },
  }),
}));

type TranslationModule = { useTranslation: () => { t: (key: string) => string } };

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<TranslationModule>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => i18n.t(key) }) };
});

vi.mock('react-native', () => ({
  Alert: { alert: holder.alert, prompt: holder.prompt },
  BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: {
    get OS() {
      return holder.platformOS;
    },
  },
  Pressable: 'Pressable',
  View: 'View',
  useColorScheme: () => 'light',
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// The overlay moves VoiceOver focus on open; the real helper reaches
// `AccessibilityInfo`/`findNodeHandle`, which the `react-native` stub above
// does not carry. `status-announcement` (inside `QueryError`) still needs the
// announce half of the module.
vi.mock('@/lib/a11y/announce', () => ({
  announceForA11y: holder.announceForA11y,
  moveA11yFocus: holder.moveA11yFocus,
}));

/* eslint-disable promise/prefer-await-to-callbacks -- Reanimated's withTiming
   takes an animation-completion callback, not a promise. */
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  useSharedValue: (initial: number) => ({ value: initial }),
  useAnimatedStyle: (style: () => Record<string, unknown>) => style(),
  withTiming: (to: number, _config?: unknown, callback?: (finished: boolean) => void) => {
    callback?.(true);
    return to;
  },
}));
/* eslint-enable promise/prefer-await-to-callbacks */

vi.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: () => void) => {
    fn();
  },
}));

vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Pan: () => {
      const chain: Record<string, () => unknown> = {};
      chain.onUpdate = () => chain;
      chain.onEnd = () => chain;
      chain.activeOffsetY = () => chain;
      return chain;
    },
  },
  GestureDetector: 'GestureDetector',
  GestureHandlerRootView: 'GestureHandlerRootView',
}));

// The real `Portal` renders `null` on its first commit and only hands the card
// and panel to the host on the next one, so the overlay's `visible` effect runs
// while the first menu row's ref is still null. This mock keeps that one-commit
// indirection: children appear only after the portal's own mount effect, which
// is what a test must exercise to see the focus land.
vi.mock('@rn-primitives/portal', async () => {
  const React = await import('react');
  function Portal({ children }: { children: ReactNode }) {
    const [mounted, setMounted] = React.useState(false);
    React.useEffect(() => {
      setMounted(true);
    }, []);
    return mounted ? React.createElement(React.Fragment, null, children) : null;
  }
  return { Portal };
});

vi.mock('expo-blur', () => ({ BlurView: 'BlurView' }));

vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Lock: 'Lock',
  MessageCircle: 'MessageCircle',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));

vi.mock('@/components/agents/session-detail-skeleton', () => ({
  SessionSkeletonMessages: 'SessionSkeletonMessages',
}));
vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));
// The clipboard/haptics stubs need no promise: nothing in this suite awaits
// them, and `copySessionId` only checks the awaited value's truthiness.
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(() => true) }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The transcript list is exercised by its own suite; here it is a thin harness
// that renders the overlay's own renderItem for each item it was handed, which
// is exactly the wiring this suite owns.
vi.mock('@/components/agents/session-message-list', async () => {
  const React = await import('react');
  return {
    SessionMessageList: (props: {
      items: readonly TestMessage[];
      keyExtractor: (item: TestMessage) => string;
      renderItem: (info: { item: TestMessage; index: number; target: string }) => ReactNode;
    }) =>
      React.createElement(
        'SessionMessageList',
        { itemCount: props.items.length },
        props.items.map((item, index) =>
          React.createElement(
            'Row',
            { key: props.keyExtractor(item) },
            props.renderItem({ item, index, target: 'cell' })
          )
        )
      ),
  };
});

vi.mock('@/components/agents/message-bubble', async () => {
  const React = await import('react');
  return {
    MessageBubble: (props: { message: TestMessage }) =>
      React.createElement('MessageBubble', { messageId: props.message.info.id }),
  };
});

export const BASE_TARGET: SessionPreviewTarget = {
  sessionId: 'ses-1',
  title: 'Fix login',
  initialRenameValue: 'Fix login',
  live: false,
  statusKind: 'running',
  needsInput: false,
  totalCostMicrodollars: null,
};

export function targetWith(over: Partial<SessionPreviewTarget>): SessionPreviewTarget {
  return { ...BASE_TARGET, ...over };
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

export function textWith(renderer: TestRenderer.ReactTestRenderer, value: string) {
  return renderer.root.findAllByProps({ children: value });
}

export function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string): void {
  const target = renderer.root.findAllByProps({ accessibilityLabel: label })[0];
  if (!target) {
    throw new Error(`missing pressable labelled ${label}`);
  }
  act(() => {
    (target.props.onPress as () => void)();
  });
}

export function mountOverlay(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(SessionPreviewOverlay));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mounted.push(renderer);
  return renderer;
}

export function openPreview(target: SessionPreviewTarget): void {
  act(() => {
    openSessionPreviewStore(target);
  });
}

export function resetPreviewHolder(): void {
  holder.transcript.data = undefined;
  holder.transcript.isLoading = false;
  holder.transcript.isError = false;
  holder.transcript.error = null;
  holder.transcript.refetch.mockClear();
  holder.row.data = undefined;
  holder.platformOS = 'ios';
  holder.alert.mockClear();
  holder.prompt.mockClear();
  holder.announceForA11y.mockClear();
  holder.moveA11yFocus.mockClear();
  holder.focusMoveHadNode.length = 0;
}

export function resetPreviewStore(): void {
  for (const renderer of mounted.splice(0)) {
    act(() => {
      renderer.unmount();
    });
  }
  if (getSessionPreviewSnapshot().target) {
    closeSessionPreviewStore();
    releaseSessionPreviewStore();
  }
}

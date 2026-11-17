/* eslint-disable max-lines -- one mounted suite: the preview transcript's row-press wiring to the read-only part detail sheet */
import { type Part, type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { SessionPreviewTranscript } from './session-preview-transcript';

const { requestMock, readMock, writeMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  readMock: vi.fn(),
  writeMock: vi.fn(),
}));

// The row asks the runtime for a translation of its label; the runtime's client
// and encrypted-KV store are the only network/native edges of that path.
vi.mock('@/lib/tool-summary-translation/tool-summary-translation-client', () => ({
  requestToolSummaryTranslations: requestMock,
}));
vi.mock('@/lib/persist/tool-summary-translation-cache', () => ({
  readToolSummaryTranslations: readMock,
  writeToolSummaryTranslation: writeMock,
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    background: '#000000',
    destructive: '#BE4E3F',
    foreground: '#FFFFFF',
    mutedForeground: '#999999',
  }),
}));
// The Lucide runtime is Flow-sourced react-native code the node project cannot
// parse, so every icon export becomes a same-named host element. The whole
// tool-cards barrel loads with the transcript, so the set of names is not this
// suite's business: a Proxy answers whatever each card imports.
vi.mock('@/components/ui/icons', () => {
  const icons = new Proxy(
    {},
    {
      get: (_target, name) => (typeof name === 'string' ? `Icon:${name}` : undefined),
      getOwnPropertyDescriptor: (_target, name) =>
        typeof name === 'string'
          ? { configurable: true, enumerable: true, value: `Icon:${name}`, writable: false }
          : undefined,
      has: () => true,
    }
  );
  return icons;
});
// `vi.mock` factories are hoisted above this file's static imports, so `react`
// is not initialised yet; the factory loads it itself.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});
vi.mock('@/components/ui/selectable-text', () => ({
  SelectableText: 'SelectableText',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
// The image surface is expo-image wrapped by nativewind, which loads the Expo
// runtime; nothing here renders an image.
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));
vi.mock('@/components/add-credits-row', () => ({ AddCreditsRow: 'AddCreditsRow' }));
vi.mock('@/components/agents/session-detail-skeleton', () => ({
  SessionSkeletonMessages: 'SessionSkeletonMessages',
}));
// RNGH ships Flow source the node project cannot parse; the sheet's mono block
// reads the ScrollView it re-exports.
vi.mock('react-native-gesture-handler', () => ({
  ScrollView: 'ScrollView',
}));
// The image viewer the sheet links to reaches the zoom toolkit and worklets,
// whose native entries this project cannot load; no fixture here has an image
// attachment, so the viewer only needs to exist.
vi.mock('react-native-zoom-toolkit', () => ({ ResumableZoom: 'ResumableZoom' }));
vi.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: () => void) => {
    fn();
  },
  scheduleOnUI: (fn: () => void) => {
    fn();
  },
}));
// `@/lib/a11y/motion` reads battery state through expo-battery, whose
// expo-modules-core entry needs React Native's `__DEV__` global. Stub the native
// module so the motion policy stays real.
vi.mock('expo-battery', () => ({
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3, NOT_CHARGING: 4 },
  useBatteryLevel: () => 1,
  useBatteryState: () => 3,
}));
// Reanimated's module initializers cannot load under the node project; the
// motion this tree reads is asserted through host elements, as in the list
// suite.
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  cancelAnimation: vi.fn(),
  Easing: { ease: 'ease', inOut: () => 'inOut', out: () => undefined },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  makeMutable: (value: unknown) => ({ value }),
  ReduceMotion: { Always: 'always', Never: 'never', System: 'system' },
  ReducedMotionConfig: 'ReducedMotionConfig',
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (value: unknown) => ({ value }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./tool-card-image-cache', () => ({
  isToolCardImagePending: () => false,
  useToolCardImageUri: () => undefined,
}));
// The markdown and file surfaces are native-backed and irrelevant to a row of
// tool cards; their modules still load with the bubble, so they are stubs.
vi.mock('./chat-markdown-text', () => ({ ChatMarkdownText: 'ChatMarkdownText' }));
vi.mock('./file-part-renderer', () => ({ FilePartRenderer: () => null }));
// The sheet's file-attachment rows reach expo-file-system and the share module,
// which need the Expo runtime; a bash part carries no attachments.
vi.mock('./tool-card-file-attachments', () => ({ ToolCardFileAttachments: () => null }));
// The MCP app card reaches the harness SDK's remote-mcp plugin, whose package
// entry resolves to an unbuilt `dist` in the node project; the card is a
// sentinel like the other unrelated cards here.
vi.mock('./tool-cards/mcp-app-card', () => ({ McpAppToolCard: 'McpAppToolCard' }));

// The transcript list is exercised by its own suite; here it renders the
// transcript's own renderItem for each item it was handed, which is the wiring
// this suite owns (same harness as `session-preview-overlay.test-helpers`).
// The factory is hoisted, so it loads `react` itself.
vi.mock('./session-message-list', async () => {
  const React = await import('react');
  type ListProps = {
    items: readonly StoredMessage[];
    keyExtractor: (item: StoredMessage) => string;
    renderItem: (info: { item: StoredMessage; index: number; target: string }) => ReactNode;
  };
  return {
    SessionMessageList: (props: ListProps) =>
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

const COMMAND = 'pnpm exec vitest run';

/** Four lines of completed bash output, longer than any row label. */
const OUTPUT = [
  '$ pnpm exec vitest run --project mobile-mounted',
  'RUN  v3.2.4 /home/kwf/work/cloud/apps/mobile',
  'Test Files  1 passed (1)',
  'Tests  3 passed (3)',
].join('\n');

function makeBashPart(id: string, command: string, output: string): ToolPart {
  return {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: `call-${id}`,
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command },
      output,
      title: 'bash',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function makeAssistantMessage(id: string, parts: Part[]): StoredMessage {
  return {
    info: {
      id,
      sessionID: 's1',
      role: 'assistant',
      time: { created: 1 },
      parentID: 'msg-parent',
      modelID: 'anthropic/claude-sonnet-4',
      providerID: 'kilo',
      mode: 'code',
      agent: 'test-agent',
      path: { cwd: '/', root: '/' },
      cost: 1,
      tokens: {
        input: 10,
        output: 1,
        reasoning: 2,
        cache: { read: 3, write: 4 },
      },
    },
    parts,
  };
}

function transcriptElement(messages: StoredMessage[]): ReactElement {
  return createElement(SessionPreviewTranscript, {
    sessionId: 's1',
    messages,
    isLoading: false,
    isError: false,
    error: undefined,
    onRetry: () => undefined,
  });
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

function mountTranscript(messages: StoredMessage[]): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(transcriptElement(messages));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mounted.push(renderer);
  return renderer;
}

function propOf(instance: TestRenderer.ReactTestInstance, key: string): unknown {
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

/** The bash row's own Pressable, named by the label the card composes. */
function toolRow(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const label = i18n.t('agentChat.toolCard.accessibilityLabel', {
    name: COMMAND,
    status: i18n.t('common.completed'),
  });
  const rows = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      propOf(node, 'accessibilityLabel') === label
  );
  const [row] = rows;
  if (rows.length !== 1 || !row) {
    throw new Error(`expected one tool row labelled ${label}, found ${rows.length}`);
  }
  return row;
}

/** The part detail sheet's mono block for the completed output. */
function sheetOutput(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'SelectableText' &&
      propOf(node, 'children') === OUTPUT
  );
}

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => {
      renderer.unmount();
    });
  }
  requestMock.mockClear();
  readMock.mockClear();
  writeMock.mockClear();
});

describe('SessionPreviewTranscript part detail', () => {
  it('opens the part detail sheet from a tool row press', () => {
    const renderer = mountTranscript([
      makeAssistantMessage('m1', [makeBashPart('bash-1', COMMAND, OUTPUT)]),
    ]);

    // The row is live: the transcript mounts the host that supplies the press
    // handler, so the row is not the dead, disabled chrome of a bare preview.
    const row = toolRow(renderer);
    expect(propOf(row, 'accessibilityState')).toEqual({ disabled: false });
    const onPress = propOf(row, 'onPress');
    expect(onPress).toBeTypeOf('function');

    // Nothing is presented before the press.
    expect(sheetOutput(renderer)).toHaveLength(0);

    act(() => {
      (onPress as () => void)();
    });

    // The read-only sheet shows the completed bash output.
    expect(sheetOutput(renderer)).toHaveLength(1);
  });
});

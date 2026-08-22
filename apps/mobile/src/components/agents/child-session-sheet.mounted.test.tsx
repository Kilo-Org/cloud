/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/ui/selectable-text.mounted.test.tsx) */
import { type ComponentProps, createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ChildSessionHydrationState,
  type OlderMessagesError,
  type StoredMessage,
  type TextPart,
} from '@kilocode/cloud-agent-sdk';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { ChildSessionSheet } from './child-session-sheet';
import { ChildSessionModelLabel } from './child-session-model-label';

const reactNativeMock = vi.hoisted(() => ({
  Platform: { OS: 'ios' as string },
  useWindowDimensions: vi.fn(() => ({ width: 390, height: 844 })),
}));
const safeAreaMock = vi.hoisted(() => ({
  useSafeAreaInsets: vi.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
}));

vi.mock('react-native', () => ({
  Modal: 'Modal',
  View: 'View',
  Pressable: 'Pressable',
  Platform: reactNativeMock.Platform,
  useWindowDimensions: reactNativeMock.useWindowDimensions,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  LinearTransition: { duration: () => ({}) },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: safeAreaMock.useSafeAreaInsets,
}));
// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose node_modules
// `.mjs` contains JSX that this pipeline cannot transform. Provide a real context
// so any `useContext(TextClassContext)` consumer still resolves.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  ChevronRight: 'ChevronRight',
  Loader2: 'Loader2',
}));
vi.mock('@/components/ui/spinning-icon', () => ({
  SpinningIcon: 'SpinningIcon',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({}),
}));
vi.mock('./session-message-list', () => ({
  SessionMessageList: () => null,
}));
vi.mock('./part-detail-sheet-host', () => ({
  PartDetailSheetHost: ({ children }: { children?: unknown }) => children,
}));
vi.mock('./working-indicator', () => ({
  WorkingIndicator: () => null,
}));
vi.mock('./message-error-boundary', () => ({
  MessageErrorBoundary: ({ children }: { children?: unknown }) => children,
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
}));
vi.mock('@/components/query-error', () => ({
  QueryError: 'QueryError',
}));
vi.mock('@/components/sheet-header', () => ({
  SheetHeader: 'SheetHeader',
}));

const modelOption: SessionModelOption = {
  id: 'kilo/model',
  name: 'Test Model',
  displayId: 'model',
  variants: [],
  isPreferred: false,
  showGatewayMetadata: false,
  provider: { id: 'kilo', name: 'Kilo' },
  modelRef: { providerID: 'kilo', modelID: 'model' },
};

function makeTextPart(text: string): TextPart {
  return { id: 't1', sessionID: 's1', messageID: 'm1', type: 'text', text };
}

function makeAssistantMessage(): StoredMessage {
  return {
    info: {
      id: 'm1',
      sessionID: 's1',
      role: 'assistant',
      time: { created: 1 },
      parentID: 'm0',
      modelID: 'model',
      providerID: 'kilo',
      mode: 'code',
      agent: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [makeTextPart('child text')],
  };
}

const readyState: ChildSessionHydrationState = {
  status: 'ready',
  cursor: null,
  hasOlder: false,
  isLoadingOlder: false,
  olderError: null,
  omittedItemCount: 0,
};

const errorState: ChildSessionHydrationState = { status: 'error', message: 'Failed' };

type SheetPropsFixture = {
  getChildMessages: (sessionId: string) => StoredMessage[];
  hydrationState: ChildSessionHydrationState;
};

function buildProps({
  getChildMessages,
  hydrationState,
}: SheetPropsFixture): ComponentProps<typeof ChildSessionSheet> {
  return {
    visible: true,
    sessionId: 'child-1',
    title: 'Subagent',
    getChildMessages,
    hydrationState,
    sessionError: null,
    isStreaming: false,
    hasOlderMessages: false,
    isLoadingOlderMessages: false,
    olderMessagesError: null as OlderMessagesError | null,
    olderMessagesOmittedItemCount: 0,
    onLoadOlderMessages: vi.fn<() => void>(),
    renderPart: () => null,
    onOpenChildSession: vi.fn<(sessionId: string, title: string) => void>(),
    onRetry: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
    modelOptions: [modelOption],
  };
}

async function renderSheet(props: ComponentProps<typeof ChildSessionSheet>) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(ChildSessionSheet, props));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findByTestID(
  root: TestRenderer.ReactTestInstance,
  testID: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.props.testID === testID);
}

function modal(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const found = root.findAll(node => (node.type as string) === 'Modal');
  const node = found[0];
  if (!node) {
    throw new Error('Modal not found');
  }
  return node;
}

beforeEach(() => {
  reactNativeMock.Platform.OS = 'ios';
  reactNativeMock.useWindowDimensions.mockReturnValue({ width: 390, height: 844 });
  safeAreaMock.useSafeAreaInsets.mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0 });
});

describe('ChildSessionSheet mounted', () => {
  it('renders the model row when child messages carry model data', async () => {
    const messages = [makeAssistantMessage()];
    const renderer = await renderSheet(
      buildProps({
        getChildMessages: () => messages,
        hydrationState: readyState,
      })
    );

    const labels = renderer.root.findAllByType(ChildSessionModelLabel);
    expect(labels).toHaveLength(1);
    expect(labels[0]?.props).toMatchObject({ modelLabel: 'Test Model' });

    const a11yNodes = renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Model: Test Model'
    );
    expect(a11yNodes).toHaveLength(1);
  });

  it('renders no model row for an empty transcript', async () => {
    const renderer = await renderSheet(
      buildProps({
        getChildMessages: () => [],
        hydrationState: readyState,
      })
    );

    expect(renderer.root.findAllByType(ChildSessionModelLabel)).toHaveLength(0);
  });

  it('renders the QueryError and no model row when hydration fails', async () => {
    const renderer = await renderSheet(
      buildProps({
        getChildMessages: () => [],
        hydrationState: errorState,
      })
    );

    expect(renderer.root.findAllByType(ChildSessionModelLabel)).toHaveLength(0);
    const errors = renderer.root.findAll(node => (node.type as string) === 'QueryError');
    expect(errors).toHaveLength(1);
  });
});

describe('ChildSessionSheet sheet surface', () => {
  it('renders the native pageSheet Modal on iOS and preserves onDismiss', async () => {
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const renderer = await renderSheet({
      ...buildProps({ getChildMessages: () => [], hydrationState: readyState }),
      onClose,
      onDismiss,
    });

    const modalNode = modal(renderer.root);
    expect(modalNode.props.animationType).toBe('slide');
    expect(modalNode.props.presentationStyle).toBe('pageSheet');
    expect(modalNode.props.transparent).toBeUndefined();
    expect(modalNode.props.onRequestClose).toBe(onClose);
    expect(modalNode.props.onDismiss).toBe(onDismiss);

    expect(findByTestID(renderer.root, 'session-page-sheet-scrim')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'session-page-sheet-surface')).toHaveLength(0);
  });

  it('renders a transparent Modal with a blocking scrim and half-height surface on Android', async () => {
    reactNativeMock.Platform.OS = 'android';
    reactNativeMock.useWindowDimensions.mockReturnValue({ width: 390, height: 800 });
    safeAreaMock.useSafeAreaInsets.mockReturnValue({ top: 24, bottom: 34, left: 0, right: 0 });

    const renderer = await renderSheet(
      buildProps({ getChildMessages: () => [], hydrationState: readyState })
    );

    const modalNode = modal(renderer.root);
    expect(modalNode.props.transparent).toBe(true);

    const scrim = findByTestID(renderer.root, 'session-page-sheet-scrim');
    expect(scrim).toHaveLength(1);
    // The scrim is a Pressable that consumes touches, so the session behind
    // cannot receive them.
    expect(scrim[0]?.type).toBe('Pressable');

    const surface = findByTestID(renderer.root, 'session-page-sheet-surface');
    expect(surface).toHaveLength(1);
    // usable = 800 - 24 - 34 = 742; half = 371.
    expect(surface[0]?.props.style).toEqual({ height: 371 });
  });

  it('closes when the Android scrim is pressed', async () => {
    reactNativeMock.Platform.OS = 'android';
    const onClose = vi.fn<() => void>();
    const renderer = await renderSheet({
      ...buildProps({ getChildMessages: () => [], hydrationState: readyState }),
      onClose,
    });

    const scrim = findByTestID(renderer.root, 'session-page-sheet-scrim')[0];
    if (!scrim) {
      throw new Error('scrim not found');
    }
    await act(async () => {
      await Promise.resolve();
      (scrim.props.onPress as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when Android Back fires onRequestClose', async () => {
    reactNativeMock.Platform.OS = 'android';
    const onClose = vi.fn<() => void>();
    const renderer = await renderSheet({
      ...buildProps({ getChildMessages: () => [], hydrationState: readyState }),
      onClose,
    });

    await act(async () => {
      await Promise.resolve();
      (modal(renderer.root).props.onRequestClose as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when Done is pressed', async () => {
    const onClose = vi.fn<() => void>();
    const renderer = await renderSheet({
      ...buildProps({ getChildMessages: () => [], hydrationState: readyState }),
      onClose,
    });

    const header = renderer.root.findAll(node => (node.type as string) === 'SheetHeader')[0];
    if (!header) {
      throw new Error('SheetHeader not found');
    }
    await act(async () => {
      await Promise.resolve();
      (header.props.onDone as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

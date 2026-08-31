/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest. */
import { type ComponentProps, createElement, type ReactNode } from 'react';
import { type FlashListProps } from '@shopify/flash-list';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, vi } from 'vitest';

import {
  type ChildSessionHydrationState,
  createSessionManager,
  type KiloSessionId,
  type SessionManager,
  type SessionManagerConfig,
  type SessionSnapshotPageOutcome,
  type StoredMessage,
} from '@kilocode/cloud-agent-sdk';
import { createJotaiStorage } from '@kilocode/cloud-agent-sdk/storage/jotai';
import { createStore } from 'jotai';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { ChildSessionSheet } from './child-session-sheet';

const reactNativeMock = vi.hoisted(() => ({
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: 'ios' as string },
  useWindowDimensions: vi.fn(() => ({ width: 390, height: 844 })),
}));
const safeAreaMock = vi.hoisted(() => ({
  useSafeAreaInsets: vi.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
}));
export { reactNativeMock, safeAreaMock };

vi.mock('react-native', () => ({
  Modal: 'Modal',
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  ...reactNativeMock,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  LinearTransition: { duration: () => ({}) },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  useReducedMotion: () => false,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: safeAreaMock.useSafeAreaInsets,
}));
// The real text component loads slot's untransformed JSX. Keep its context
// so the real Button and its accessibility state still render here.
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
  ChevronDown: 'ChevronDown',
  Loader2: 'Loader2',
  AlertCircle: 'AlertCircle',
  Check: 'Check',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/spinning-icon', () => ({
  SpinningIcon: 'SpinningIcon',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({}),
}));
vi.mock('@shopify/flash-list', async () => {
  const React = await import('react');
  return {
    FlashList: (props: FlashListProps<StoredMessage>) =>
      React.createElement(
        'FlashList',
        props,
        props.ListHeaderComponent as ReactNode,
        props.data?.map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: props.keyExtractor?.(item, index) },
            props.renderItem?.({ item, index, target: 'Cell' })
          )
        ),
        props.ListFooterComponent as ReactNode
      ),
  };
});
vi.mock('./part-detail-sheet-host', () => ({
  PartDetailSheetHost: ({ children }: { children?: unknown }) => children,
}));
vi.mock('./working-indicator', () => ({
  WorkingIndicator: () => null,
}));
vi.mock('./message-error-boundary', () => ({
  MessageErrorBoundary: ({ children }: { children?: unknown }) => children,
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

export function makeAssistantMessage(
  id = 'm1',
  text = 'child text',
  sessionID = 'child-1'
): StoredMessage {
  return {
    info: {
      id,
      sessionID,
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
    parts: [{ id: `text-${id}`, sessionID, messageID: id, type: 'text', text }],
  };
}

export const readyState: ChildSessionHydrationState = {
  status: 'ready',
  cursor: null,
  hasOlder: false,
  isLoadingOlder: false,
  olderError: null,
  omittedItemCount: 0,
};
export const errorState: ChildSessionHydrationState = { status: 'error', message: 'Failed' };

export type SheetProps = ComponentProps<typeof ChildSessionSheet>;

export function buildProps({
  getChildMessages,
  hydrationState,
}: Pick<SheetProps, 'getChildMessages' | 'hydrationState'>): SheetProps {
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
    olderMessagesError: null,
    olderMessagesOmittedItemCount: 0,
    onLoadOlderMessages: vi.fn<() => void>(),
    renderPart: ({ part }) =>
      part.type === 'text' ? createElement('Text', null, part.text) : null,
    onOpenChildSession: vi.fn<(sessionId: string, title: string) => void>(),
    onRetry: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
    modelOptions: [modelOption],
  };
}

// Observe the manager's real storage without replacing its replay or deduplication.
vi.mock('@kilocode/cloud-agent-sdk/storage/jotai', { spy: true });
const managers: SessionManager[] = [];

export function historyPage(
  messages: StoredMessage[] = [],
  nextCursor: string | null = null,
  sessionId = 'child-1'
): SessionSnapshotPageOutcome {
  return { kind: 'success', info: { id: sessionId }, messages, nextCursor, omittedItemCount: 0 };
}

export async function createRecoverySource(
  fetchPage: NonNullable<SessionManagerConfig['fetchSnapshotPage']>
) {
  const store = createStore();
  const rootId = 'root' as KiloSessionId;
  const userWebConnection = {
    subscribeToCliSession: vi.fn().mockReturnValue(vi.fn()),
    onSystemEvent: vi.fn().mockReturnValue(vi.fn()),
  };
  const api = {};
  const manager = createSessionManager({
    store,
    resolveSession: vi.fn<SessionManagerConfig['resolveSession']>().mockResolvedValue({
      type: 'read-only',
      kiloSessionId: rootId,
    }),
    fetchSession: vi.fn<SessionManagerConfig['fetchSession']>().mockResolvedValue({
      kiloSessionId: rootId,
      cloudAgentSessionId: null,
      title: 'Root',
      organizationId: null,
      gitUrl: null,
      gitBranch: null,
      mode: null,
      model: null,
      variant: null,
      repository: null,
      isInitiated: true,
      needsLegacyPrepare: false,
      isPreparingAsync: false,
      prompt: null,
      initialMessageId: null,
      associatedPr: null,
    }),
    fetchSnapshot: vi.fn<SessionManagerConfig['fetchSnapshot']>(),
    fetchSnapshotPage: async (id, options) => {
      const page = id === rootId ? historyPage([], null, id) : await fetchPage(id, options);
      return page;
    },
    getTicket: vi.fn<SessionManagerConfig['getTicket']>(),
    prepare: vi.fn<SessionManagerConfig['prepare']>(),
    initiate: vi.fn<SessionManagerConfig['initiate']>(),
    // The read-only root uses only the upgrade watcher's subscription methods.
    userWebConnection: userWebConnection as SessionManagerConfig['userWebConnection'],
    api: api as SessionManagerConfig['api'],
  });
  managers.push(manager);
  await manager.switchSession(rootId);
  const result = vi.mocked(createJotaiStorage).mock.results.at(-1);
  if (result?.type !== 'return') {
    throw new Error('manager storage was not created');
  }
  return { manager, store, storage: result.value };
}

const mountedSheets: TestRenderer.ReactTestRenderer[] = [];
export const viewport = { offset: 0 };

export async function renderSheet(props: SheetProps) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(ChildSessionSheet, props), {
      createNodeMock: element => {
        if (element.type !== 'FlashList') {
          return null;
        }
        viewport.offset = 0;
        return {
          scrollToEnd: () => {
            viewport.offset = 2000;
          },
        };
      },
    });
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedSheets.push(renderer);
  return renderer;
}

export async function updateSheet(renderer: TestRenderer.ReactTestRenderer, props: SheetProps) {
  await act(async () => {
    await Promise.resolve();
    renderer.update(createElement(ChildSessionSheet, props));
  });
}

export function host(root: TestRenderer.ReactTestInstance, type: string) {
  return root.find(node => (node.type as string) === type);
}

export function textValues(root: TestRenderer.ReactTestInstance) {
  return root.findAll(node => (node.type as string) === 'Text').map(node => node.props.children);
}

export function retryButton(root: TestRenderer.ReactTestInstance) {
  return root.find(
    node => (node.type as string) === 'Pressable' && node.props.accessibilityLabel === 'Retry'
  );
}

export function findByTestID(root: TestRenderer.ReactTestInstance, testID: string) {
  return root.findAll(node => node.props.testID === testID);
}

export function modal(root: TestRenderer.ReactTestInstance) {
  return host(root, 'Modal');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  reactNativeMock.Platform.OS = 'ios';
  reactNativeMock.useWindowDimensions.mockReturnValue({ width: 390, height: 844 });
  safeAreaMock.useSafeAreaInsets.mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0 });
});

afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
    for (const renderer of mountedSheets.splice(0)) {
      renderer.unmount();
    }
    for (const manager of managers.splice(0)) {
      manager.destroy();
    }
  });
  vi.useRealTimers();
});

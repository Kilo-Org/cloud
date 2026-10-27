import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ChatLayout from '@/app/(app)/(tabs)/(4_chat)/_layout';
import { TabStackErrorBoundary } from './tab-stack-error-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { act, TestRenderer } from '@/test/renderer';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';

let events: TelemetryEvent[] = [];

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios' },
  I18nManager: { isRTL: false },
}));
const chatStack = vi.hoisted(() => ({ shouldThrow: true }));

vi.mock('expo-router', () => ({
  Stack: () => {
    if (chatStack.shouldThrow) {
      throw new Error('chat stack render failed');
    }
    return createElement('ChatStackContent');
  },
}));
vi.mock('@/components/app-screen-layout', () => ({ appSceneLayout: 'SceneLayout' }));
vi.mock('@/components/tab-screen-input-gate', () => ({
  TabSwitchInputSettle: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#fff',
    foreground: '#000',
    mutedForeground: '#666',
  }),
}));

function ThrowingStack({ throwFor }: Readonly<{ throwFor: { current: boolean } }>) {
  if (throwFor.current) {
    throw new Error('tab render failed');
  }
  return createElement('TabStackContent');
}

function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const holder: { tree?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.tree = TestRenderer.create(
      createElement(QueryClientProvider, { client }, children) as ReactElement
    );
  });
  const tree = holder.tree;
  if (!tree) {
    throw new Error('boundary did not mount');
  }
  return { tree, client };
}

function deferred() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return { promise, resolve };
}

function makeBoundary(
  throwFor: { current: boolean },
  queryPrefixes: readonly (readonly unknown[])[]
) {
  return createElement(
    TabStackErrorBoundary,
    { titleKey: 'common.agents', subsystem: 'agents', queryPrefixes },
    createElement(ThrowingStack, { throwFor })
  );
}

function pressRetry(tree: TestRenderer.ReactTestRenderer) {
  const retry = tree.root.findByType(QueryError as never).props.onRetry as () => void;
  act(() => {
    retry();
  });
}

beforeEach(() => {
  events = [];
  setTelemetrySink(event => {
    events.push(event);
  });
  chatStack.shouldThrow = true;
});

describe('TabStackErrorBoundary', () => {
  it('keeps the tab header and scroll viewport when a stack screen throws', () => {
    const { tree } = mount(makeBoundary({ current: true }, [[['cliSessionsV2']]]));

    expect(tree.root.findByType(ScreenHeader as never).props).toMatchObject({
      title: 'common.agents',
      showBackButton: false,
    });
    expect(tree.root.findAllByType(TabScreenScrollView as never)).toHaveLength(1);
    expect(tree.root.findAllByType(QueryError as never)).toHaveLength(1);
    expect(tree.root.findAll(node => String(node.type) === 'TabStackContent')).toHaveLength(0);
    expect(events[0]?.tags).toEqual({
      'error.subsystem': 'agents',
      'error.operation': 'render_stack',
    });
  });

  it('contains a Chat stack render error and retries its list and model reads in place', async () => {
    const { tree, client } = mount(createElement(ChatLayout));
    const refetch = vi.spyOn(client, 'refetchQueries').mockResolvedValue(undefined);

    expect(tree.root.findByType(ScreenHeader as never).props).toMatchObject({
      title: 'common.chat',
      showBackButton: false,
    });
    expect(events[0]?.tags).toEqual({
      'error.subsystem': 'chat',
      'error.operation': 'render_stack',
    });

    chatStack.shouldThrow = false;
    await act(async () => {
      pressRetry(tree);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refetch.mock.calls.map(call => call[0]?.queryKey)).toEqual([
      ['chats'],
      ['available-models'],
    ]);
    expect(tree.root.findAllByType(QueryError as never)).toHaveLength(0);
    expect(tree.root.findAll(node => String(node.type) === 'ChatStackContent')).toHaveLength(1);
  });

  it('refetches only this tab’s reads before remounting the stack', async () => {
    const throwFor = { current: true };
    const queryPrefixes = [[['cliSessionsV2']], [['activeSessions']]] as const;
    const { tree, client } = mount(makeBoundary(throwFor, queryPrefixes));
    const recovery = deferred();
    const refetch = vi.spyOn(client, 'refetchQueries').mockReturnValue(recovery.promise);

    pressRetry(tree);

    expect(tree.root.findByType(QueryError as never).props.isRetrying).toBe(true);
    expect(tree.root.findAll(node => String(node.type) === 'TabStackContent')).toHaveLength(0);

    throwFor.current = false;
    await act(async () => {
      recovery.resolve(undefined);
      await recovery.promise;
    });

    expect(refetch.mock.calls.map(call => call[0]?.queryKey)).toEqual([
      [['cliSessionsV2']],
      [['activeSessions']],
    ]);
    expect(refetch.mock.calls.every(call => call[0]?.type === 'all')).toBe(true);
    expect(tree.root.findAllByType(QueryError as never)).toHaveLength(0);
    expect(tree.root.findAll(node => String(node.type) === 'TabStackContent')).toHaveLength(1);
  });
});

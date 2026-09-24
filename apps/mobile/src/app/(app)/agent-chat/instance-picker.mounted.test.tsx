/* eslint-disable max-lines -- the full react-native + FlashList mock harness stays inline so the picker's list contract reads as one screen */

// Instance picker list contract: the instances query must poll every 10s and
// never ask TanStack Query for a focus refetch (a poll tick and a foreground
// return would otherwise fire two `activeSessions.listInstances` calls at the
// same moment), and the Cloud Agent header plus the instance rows must render
// through the FlashList the picker now uses.

import { createElement, type EffectCallback, Fragment, type ReactNode, useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, TestRenderer } from '@/test/renderer';
import { createTestQueryClient } from '@/test/render-with-providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InstancePickerScreen from './instance-picker';
import '@/i18n';

import { type InstancePickerInstance } from '@/lib/picker-bridge';

const fetchInstances = vi.hoisted(() =>
  vi.fn<() => Promise<{ instances: InstancePickerInstance[] }>>()
);
const queryOptionsCalls = vi.hoisted(() => [] as Record<string, unknown>[]);
const bridge = vi.hoisted(() => ({
  currentValue: null as InstancePickerInstance | null,
  onSelect: vi.fn(),
}));
const insets = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const router = vi.hoisted(() => ({ back: vi.fn() }));

// FlatList and FlashList both render through a callback, so a host-string mock
// would drop every row and the ListHeaderComponent. This mock mirrors the real
// list: rows via renderItem, the header always, and the empty component only
// when the data is empty — which lets the test assert the Cloud Agent row and
// the instance rows are rendered through FlashList.
const flashListMock = vi.hoisted(
  () =>
    (props: {
      data: readonly { key: string }[];
      renderItem?: (info: { item: { key: string }; index: number }) => ReactNode;
      keyExtractor?: (item: { key: string }) => string;
      ListHeaderComponent?: ReactNode;
      ListEmptyComponent?: ReactNode;
    }) => {
      const rows = props.data.map((item, index) =>
        createElement(
          Fragment,
          { key: props.keyExtractor ? props.keyExtractor(item) : String(index) },
          props.renderItem ? props.renderItem({ item, index }) : null
        )
      );
      const empty = props.data.length === 0 ? props.ListEmptyComponent : null;
      return createElement('FlashList', null, props.ListHeaderComponent, ...rows, empty);
    }
);

vi.mock('react-native', () => ({
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@shopify/flash-list', () => ({ FlashList: flashListMock }));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useFocusEffect: (effect: EffectCallback) => {
    // The route focus effect runs on mount and clears the bridge on unmount.
    useEffect(effect, [effect]);
  },
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets,
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  Cloud: 'Cloud',
  Info: 'Info',
  Server: 'Server',
  Terminal: 'Terminal',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#fff', foreground: '#000', primary: '#ff0' }),
}));
vi.mock('@/lib/route-registry', () => ({
  instancePickerSlot: {
    get: () => bridge,
    clear: vi.fn(),
  },
  UNFENCED_ROUTE_KEY: 'unscoped',
  useRouteRegistry: vi.fn(),
}));
// Capture the options the picker hands to the instances query, then serve the
// query from this test's fetch mock so `useQuery` receives the real object.
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: {
      listInstances: {
        queryOptions: (_input: undefined, options: Record<string, unknown>) => {
          queryOptionsCalls.push(options);
          return {
            queryKey: ['instance-picker'],
            queryFn: fetchInstances,
            ...options,
          };
        },
      },
    },
  }),
}));

const CLI_INSTANCE: InstancePickerInstance = {
  connectionId: 'cli-1',
  name: 'laptop',
  projectName: 'kilo',
  kind: 'cli',
  startedAt: null,
  gitBranch: null,
};
const REMOTE_INSTANCE: InstancePickerInstance = {
  connectionId: 'remote-1',
  name: 'workbench',
  projectName: 'site',
  kind: 'remote',
  startedAt: null,
  gitBranch: null,
};

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function textOf(root: TestRenderer.ReactTestInstance): string {
  return findByType(root, 'Text')
    .flatMap(node => node.children.filter(child => typeof child === 'string'))
    .join('\n');
}

function radios(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return findByType(root, 'Pressable').filter(
    node => (node.props as { accessibilityRole?: string }).accessibilityRole === 'radio'
  );
}

/**
 * React Query notifies its observers through its scheduler, so a single
 * microtask flush does not settle a fetch. Yield to the macrotask queue a few
 * turns inside `act` so the query state lands before the test asserts.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- each turn must flush the React Query observer notifications before the next
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    }
  });
}

/**
 * Mount the screen and flush the query. A fresh client per mount keeps one
 * test's cached instances out of the next.
 */
async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  const queryClient = createTestQueryClient();
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(InstancePickerScreen)
      )
    );
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  await settle();
  return ref.current;
}

describe('InstancePickerScreen list', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchInstances.mockReset().mockResolvedValue({ instances: [CLI_INSTANCE, REMOTE_INSTANCE] });
    queryOptionsCalls.length = 0;
    bridge.currentValue = CLI_INSTANCE;
    bridge.onSelect.mockClear();
    router.back.mockClear();
    insets.bottom = 0;
  });

  it('polls the instances query and never asks for a window-focus refetch', async () => {
    const renderer = await mount();

    expect(queryOptionsCalls.length).toBeGreaterThan(0);
    for (const options of queryOptionsCalls) {
      expect(options.refetchInterval).toBe(10_000);
      expect(options.refetchOnWindowFocus ?? false).toBe(false);
    }

    act(() => {
      renderer.unmount();
    });
  });

  it('renders the Cloud Agent header and the instance rows through FlashList', async () => {
    const renderer = await mount();

    expect(findByType(renderer.root, 'FlashList')).toHaveLength(1);
    expect(findByType(renderer.root, 'FlatList')).toHaveLength(0);
    const text = textOf(renderer.root);
    expect(text).toContain('Cloud Agent');
    expect(text).toContain('laptop');
    expect(text).toContain('workbench');
    // One radio for the Cloud Agent row plus one per instance.
    expect(radios(renderer.root)).toHaveLength(3);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the Cloud Agent row and the empty card in FlashList for zero instances', async () => {
    fetchInstances.mockResolvedValue({ instances: [] });
    const renderer = await mount();

    expect(findByType(renderer.root, 'FlashList')).toHaveLength(1);
    expect(textOf(renderer.root)).toContain('Cloud Agent');
    // The empty card is the list's ListEmptyComponent, so it only renders
    // through FlashList when the instance data is an empty array.
    expect(findByType(renderer.root, 'EmptyState')).toHaveLength(1);
    expect(radios(renderer.root)).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });
});

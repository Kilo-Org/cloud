// Hardware Back coverage for the folder picker sheet, split from the body
// suite to stay under the per-file line limit. Shares the shape of that
// suite's harness: same hoisted mocks, same mount helper.
import { createElement, Fragment, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, TestRenderer } from '@/test/renderer';
import { createTestQueryClient } from '@/test/render-with-providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listDirectoriesOnConnection } from '@kilocode/cloud-agent-sdk/list-directories';

import FolderPickerScreen from './folder-picker';
import { NavigationContext } from '@/lib/navigation/navigation-context';

const connection = vi.hoisted(() => ({
  isConnected: () => true,
  retryConnection: () => undefined,
}));
const folderPickerSlotClear = vi.hoisted(() => vi.fn());
const bridge = vi.hoisted(() => ({
  connectionId: 'conn-1',
  projectName: 'my-project',
  currentPath: '',
  onSelect: vi.fn(),
}));
const insets = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const router = vi.hoisted(() => ({ back: vi.fn() }));
// Live BackHandler harness: every armed listener registers here so a test can
// press hardware Back and observe exactly what the sheet's listener does.
const backHandlers = vi.hoisted(() => {
  const listeners = new Set<() => boolean>();
  return {
    listeners,
    press(): boolean[] {
      return [...listeners].map(listener => listener());
    },
  };
});
const navigation = vi.hoisted(() => {
  // `isFocused` reads through `state` so a listener that captured the function
  // still observes a later blur (the real context object is stable too).
  const state = { focused: true };
  return {
    state,
    isFocused: (): boolean => state.focused,
  };
});

const flashListMock = vi.hoisted(
  () =>
    (props: {
      data: readonly { name: string; path: string }[];
      renderItem?: (info: { item: { name: string; path: string }; index: number }) => ReactNode;
      keyExtractor?: (item: { name: string; path: string }) => string;
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
      const header = props.data.length > 0 ? props.ListHeaderComponent : null;
      const empty = props.data.length === 0 ? props.ListEmptyComponent : null;
      return createElement('FlashList', null, header, ...rows, empty);
    }
);

vi.mock('@shopify/flash-list', () => ({ FlashList: flashListMock }));
vi.mock('react-native', () => ({
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      backHandlers.listeners.add(listener);
      return {
        remove: () => {
          backHandlers.listeners.delete(listener);
        },
      };
    },
  },
}));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useNavigation: () => navigation,
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/ui/icons', () => ({ FolderOpen: 'FolderOpen' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6b7280' }),
}));
vi.mock('@/lib/route-registry', () => ({
  folderPickerSlot: {
    get: () => bridge,
    clear: folderPickerSlotClear,
  },
  UNFENCED_ROUTE_KEY: 'unscoped',
  useRouteRegistry: vi.fn(),
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => connection,
}));
vi.mock('@kilocode/cloud-agent-sdk/list-directories', () => ({
  listDirectoriesOnConnection: vi.fn(),
}));

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

/**
 * React Query notifies its observers through its scheduler, so a single
 * microtask flush does not settle a listing. Yield to the macrotask queue a
 * few turns inside `act` so the query state lands before the test asserts.
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

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  const queryClient = createTestQueryClient();
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(
        NavigationContext.Provider,
        { value: navigation as never },
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(FolderPickerScreen)
        )
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

const listFn = vi.mocked(listDirectoriesOnConnection);

describe('FolderPickerScreen hardware Back', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    listFn.mockReset();
    bridge.onSelect.mockClear();
    router.back.mockClear();
    folderPickerSlotClear.mockClear();
    backHandlers.listeners.clear();
    navigation.state.focused = true;
  });

  it('arms exactly one hardware-back listener for the mount lifetime', async () => {
    listFn.mockResolvedValueOnce({ ok: true, path: '', directories: [] });
    const renderer = await mount();

    expect(backHandlers.listeners.size).toBe(1);
    act(() => {
      renderer.unmount();
    });
    expect(backHandlers.listeners.size).toBe(0);
  });

  it('at the launch frame dismisses the route without committing a folder', async () => {
    listFn.mockResolvedValueOnce({ ok: true, path: '', directories: [] });
    const renderer = await mount();

    const results = backHandlers.press();
    expect(results).toEqual([true]);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(bridge.onSelect).not.toHaveBeenCalled();
    expect(folderPickerSlotClear).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('at a nested frame pops the drill first and keeps the sheet open', async () => {
    listFn.mockResolvedValueOnce({
      ok: true,
      path: '',
      directories: [{ name: 'src', path: 'src' }],
    });
    listFn.mockResolvedValueOnce({ ok: true, path: 'src', directories: [] });
    const renderer = await mount();
    const folder = findByType(renderer.root, 'Pressable')[0];
    if (!folder) {
      throw new Error('folder row did not mount');
    }
    const pressFolder = folder.props.onPress as () => void;
    act(() => {
      pressFolder();
    });
    await settle();

    // Back at a nested frame: consumed by the drill (sheet stays open).
    expect(backHandlers.press()).toEqual([true]);
    expect(router.back).not.toHaveBeenCalled();
    await settle();
    // The drill restored the parent listing: the launch frame's rows are back.
    expect(findByType(renderer.root, 'FlashList')).toHaveLength(1);

    // A second Back at the launch frame dismisses the route.
    expect(backHandlers.press()).toEqual([true]);
    expect(router.back).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.unmount();
    });
  });

  it('ignores hardware Back while the route is not focused', async () => {
    listFn.mockResolvedValueOnce({ ok: true, path: '', directories: [] });
    const renderer = await mount();
    navigation.state.focused = false;

    const results = backHandlers.press();
    expect(results).toEqual([false]);
    expect(router.back).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });
});

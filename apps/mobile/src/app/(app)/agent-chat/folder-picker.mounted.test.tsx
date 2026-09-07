/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom). */
import { createElement, Fragment, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listDirectoriesOnConnection } from '@kilocode/cloud-agent-sdk/list-directories';

import FolderPickerScreen from './folder-picker';

const connection = vi.hoisted(() => ({}));
const bridge = vi.hoisted(() => ({
  connectionId: 'conn-1',
  projectName: 'my-project',
  currentPath: '',
  onSelect: vi.fn(),
}));
const insets = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const router = vi.hoisted(() => ({ back: vi.fn() }));

// FlatList renders through a callback, so a host-string mock would drop every
// row and empty state. This mock mirrors the real list: rows via renderItem,
// the header only when there are rows, and the empty component only when the
// data is empty — which lets each phase assert its own content.
const flatListMock = vi.hoisted(
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
      return createElement('FlatList', null, header, ...rows, empty);
    }
);

vi.mock('react-native', () => ({
  FlatList: flatListMock,
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => router,
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
    clear: vi.fn(),
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

function propOf(instance: TestRenderer.ReactTestInstance | undefined, key: string): unknown {
  if (!instance) {
    return undefined;
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

/** Mount the screen and flush the hook's resolved listing promise. */
async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(FolderPickerScreen));
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

const listFn = vi.mocked(listDirectoriesOnConnection);

describe('FolderPickerScreen body', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    listFn.mockReset();
    bridge.onSelect.mockClear();
    router.back.mockClear();
    insets.bottom = 0;
  });

  it('renders one FlatList in the skeleton phase, with skeleton rows as the empty content', async () => {
    // Never resolve: the listing stays in the skeleton phase for the whole mount.
    listFn.mockReturnValueOnce(new Promise(() => undefined));
    const renderer = await mount();

    expect(findByType(renderer.root, 'FlatList')).toHaveLength(1);
    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(5);
    expect(findByType(renderer.root, 'EmptyState')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('replaces the list with the retryable state', async () => {
    listFn.mockResolvedValueOnce({ ok: false, reason: 'transport' });
    const renderer = await mount();

    expect(findByType(renderer.root, 'FlatList')).toHaveLength(0);
    const emptyState = findByType(renderer.root, 'EmptyState');
    expect(emptyState).toHaveLength(1);
    expect(propOf(emptyState[0], 'action')).toBeTruthy();
    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('replaces the list with the unsupported state without a retry action', async () => {
    listFn.mockResolvedValueOnce({ ok: false, reason: 'unsupported' });
    const renderer = await mount();

    expect(findByType(renderer.root, 'FlatList')).toHaveLength(0);
    const emptyState = findByType(renderer.root, 'EmptyState');
    expect(emptyState).toHaveLength(1);
    expect(propOf(emptyState[0], 'action')).toBeUndefined();
    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the native header mounted when a child folder is empty', async () => {
    listFn.mockResolvedValueOnce({
      ok: true,
      path: '',
      directories: [{ name: 'src', path: 'src' }],
    });
    listFn.mockResolvedValueOnce({ ok: true, path: 'src', directories: [] });
    const renderer = await mount();
    const header = findByType(renderer.root, 'SheetHeader')[0];
    const folder = findByType(renderer.root, 'Pressable')[0];
    if (!header || !folder) {
      throw new Error('Folder controls did not mount');
    }
    const group = header.parent;
    expect(group?.props.collapsable).toBe(false);
    await act(async () => {
      (folder.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(findByType(renderer.root, 'SheetHeader')[0]).toBe(header);
    expect(header.parent).toBe(group);
    expect(findByType(renderer.root, 'FlatList')).toHaveLength(0);
    expect(findByType(renderer.root, 'EmptyState')).toHaveLength(1);
    act(() => {
      (header.props.onDone as () => void)();
    });
    expect(bridge.onSelect).toHaveBeenCalledWith('src');
    act(() => {
      renderer.unmount();
    });
  });

  it('replaces the list with the ready-empty state', async () => {
    listFn.mockResolvedValueOnce({ ok: true, path: '', directories: [] });
    const renderer = await mount();

    expect(findByType(renderer.root, 'FlatList')).toHaveLength(0);
    expect(findByType(renderer.root, 'EmptyState')).toHaveLength(1);
    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(0);
    expect(findByType(renderer.root, 'Button')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});

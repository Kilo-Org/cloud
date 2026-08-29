/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the native tree without a DOM. */
import { createElement, type EffectCallback, Fragment, type ReactNode, useEffect } from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { type UseQueryOptions } from '@tanstack/react-query';

import InstancePickerScreen from '@/app/(app)/agent-chat/instance-picker';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { instancePickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import '@/i18n';

const fetchInstances = vi.hoisted(() =>
  vi.fn<() => Promise<{ instances: InstancePickerInstance[] }>>()
);
const navigation = vi.hoisted(() => ({ current: 'picker' }));
const QUERY_KEY = ['instance-picker'];

type ListProps<T> = {
  data: readonly T[];
  keyExtractor: (item: T) => string;
  renderItem: (info: { item: T }) => ReactNode;
  ListHeaderComponent?: ReactNode;
  ListEmptyComponent?: ReactNode;
};

vi.mock('react-native', () => ({
  FlatList: <T,>(props: ListProps<T>) =>
    createElement(
      'FlatList',
      props,
      props.ListHeaderComponent,
      props.data.map(item =>
        createElement(Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item }))
      ),
      props.data.length > 0 ? null : props.ListEmptyComponent
    ),
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({
    back: () => {
      navigation.current = 'caller';
    },
  }),
  useFocusEffect: (effect: EffectCallback) => {
    useEffect(effect, [effect]);
  },
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  Cloud: 'Cloud',
  Info: 'Info',
  Server: 'Server',
  Share: 'Share',
  Terminal: 'Terminal',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext('') };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000',
    mutedForeground: '#666',
    primary: '#ff0',
    primaryForeground: '#000',
  }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: {
      listInstances: {
        queryOptions: (_input: undefined, options: Partial<UseQueryOptions>) => ({
          queryKey: QUERY_KEY,
          queryFn: fetchInstances,
          ...options,
          retryDelay: 0,
        }),
      },
    },
  }),
}));

// Legacy advertisements arrive already normalized by the router, not by the picker.
const LEGACY: InstancePickerInstance = {
  connectionId: 'legacy',
  name: 'laptop',
  projectName: 'kilo',
  kind: 'cli',
  startedAt: null,
  gitBranch: null,
};
const REMOTE: InstancePickerInstance = {
  ...LEGACY,
  connectionId: 'remote',
  kind: 'remote',
  gitBranch: 'remote-main',
  startedAt: new Date(2026, 7, 28, 12, 34).toISOString(),
  capabilities: { attachments: true, sessionClone: true },
};
const TERMINAL: InstancePickerInstance = { ...LEGACY, connectionId: 'terminal', gitBranch: 'main' };
const SAME_FOLDER: InstancePickerInstance = {
  ...TERMINAL,
  connectionId: 'same-folder',
  gitBranch: 'fix/mobile',
};
const INSTANCES = [TERMINAL, REMOTE, LEGACY, SAME_FOLDER];
type Mounted = Awaited<ReturnType<typeof renderWithProviders>>;
type ControlProps = {
  testID?: string;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  accessibilityState?: { checked?: boolean; disabled?: boolean; busy?: boolean };
  disabled?: boolean;
  onPress?: () => void;
};
function controls(mounted: Mounted) {
  return mounted.renderer.root
    .findAll(node => node.type === 'Pressable')
    .map(node => node.props as ControlProps);
}
function radios(mounted: Mounted) {
  return controls(mounted).filter(props => props.accessibilityRole === 'radio');
}
function text(mounted: Mounted) {
  return mounted.renderer.root
    .findAll(node => node.type === 'Text')
    .flatMap(node => node.children.filter(child => typeof child === 'string'))
    .join('\n');
}
function press(mounted: Mounted, matches: (props: ControlProps) => boolean) {
  const control = controls(mounted).find(props => matches(props));
  expect(control).toBeDefined();
  act(() => {
    control?.onPress?.();
  });
}
async function mountScreen() {
  const mounted = await renderWithProviders(createElement(InstancePickerScreen));
  onTestFinished(mounted.unmount);
  return mounted;
}
async function openPicker(currentValue: InstancePickerInstance | null = TERMINAL) {
  const caller = { selection: currentValue };
  instancePickerSlot.set(UNFENCED_ROUTE_KEY, {
    instances: INSTANCES,
    currentValue,
    onSelect: instance => {
      caller.selection = instance;
    },
  });
  return { ...(await mountScreen()), caller };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetchInstances.mockReset().mockResolvedValue({ instances: INSTANCES });
  instancePickerSlot.clear(UNFENCED_ROUTE_KEY);
  navigation.current = 'picker';
});

describe('InstancePickerScreen', () => {
  it('groups remotes, terminals, and legacy rows with icons and accessible connection facts', async () => {
    const mounted = await openPicker();
    await waitFor(() => radios(mounted).length === 5);
    const choices = radios(mounted);
    expect(choices[0]?.testID).toBeUndefined();
    expect(new Set(choices.slice(1).map(row => row.testID)).size).toBe(4);
    expect(text(mounted)).not.toContain('instance-picker-row-');
    expect(choices.some(row => row.accessibilityLabel?.includes('instance-picker-row-'))).toBe(
      false
    );
    expect(choices.map(row => row.accessibilityLabel)).toEqual([
      'Run on Cloud Agent',
      expect.stringMatching(/Remotes.*laptop on kilo.*remote-main.*Started/),
      expect.stringMatching(/Terminals.*laptop on kilo.*main/),
      expect.stringMatching(/Terminals.*laptop on kilo/),
      expect.stringMatching(/Terminals.*laptop on kilo.*fix\/mobile/),
    ]);
    const checked = choices.map(row => row.accessibilityState?.checked);
    expect(checked).toEqual([false, false, true, false, false]);
    const headings = mounted.renderer.root.findAll(
      node => node.type === 'Text' && (node.props as ControlProps).accessibilityRole === 'header'
    );
    expect(headings.map(node => node.children)).toEqual([['Run on'], ['Remotes'], ['Terminals']]);
    expect(
      controls(mounted).some(
        row => row.accessibilityLabel === 'Remotes' || row.accessibilityLabel === 'Terminals'
      )
    ).toBe(false);
    expect(mounted.renderer.root.findAll(node => node.type === 'Server')).toHaveLength(1);
    expect(mounted.renderer.root.findAll(node => node.type === 'Terminal')).toHaveLength(3);
    expect(text(mounted)).toContain('remote-main · Started Aug 28, 2026, 12:34 PM');
  });

  it.each(
    [null, REMOTE, TERMINAL, LEGACY, SAME_FOLDER].map((target, index) => ({ target, index }))
  )(
    'selects destination $index by identifier after a refresh changes row order, facts, and groups',
    async ({ target, index }) => {
      const mounted = await openPicker(target ? null : TERMINAL);
      await waitFor(() => radios(mounted).length === 5);
      const testID = radios(mounted)[index]?.testID;
      const checkedID = radios(mounted).find(row => row.accessibilityState?.checked)?.testID;
      fetchInstances.mockResolvedValue({
        instances: [SAME_FOLDER, LEGACY, { ...REMOTE, kind: 'cli' }, TERMINAL],
      });
      await act(async () => {
        await mounted.queryClient.refetchQueries({ queryKey: QUERY_KEY });
      });
      await waitFor(() => !text(mounted).includes('Remotes'));
      expect(radios(mounted).find(row => row.accessibilityState?.checked)?.testID).toBe(checkedID);
      press(mounted, row => row.accessibilityRole === 'radio' && row.testID === testID);
      expect(mounted.caller.selection).toEqual(
        target === null ? null : expect.objectContaining({ ...target, kind: 'cli' })
      );
      expect(navigation.current).toBe('caller');
      expect(instancePickerSlot.get(UNFENCED_ROUTE_KEY)).toBeUndefined();
    }
  );

  it('keeps same-folder hashes visible and selects the exact connection by identifier', async () => {
    const first = { ...LEGACY, connectionId: 'a' };
    const second = { ...LEGACY, connectionId: 'b' };
    fetchInstances.mockResolvedValue({ instances: [first, second] });
    const mounted = await openPicker(second);
    await waitFor(() => radios(mounted).length === 3);
    expect(text(mounted)).toContain('000061');
    expect(text(mounted)).toContain('000062');
    const checked = radios(mounted).map(row => row.accessibilityState?.checked);
    expect(checked).toEqual([false, false, true]);
    press(mounted, row => row.testID === 'instance-picker-row-000061');
    expect(mounted.caller.selection?.connectionId).toBe('a');
  });

  it('shows loading skeletons rather than an empty result or stale bridge rows', async () => {
    fetchInstances.mockReturnValue(new Promise(() => undefined));
    const mounted = await openPicker();
    expect(mounted.renderer.root.findAll(node => node.type === 'Skeleton')).toHaveLength(8);
    expect(radios(mounted)).toHaveLength(0);
    expect(text(mounted)).not.toContain('No CLI instances connected');
  });

  it('shows loading progress after Retry and then recovered rows', async () => {
    fetchInstances.mockRejectedValue(new Error('offline'));
    const mounted = await openPicker();
    await waitFor(() => text(mounted).includes("Couldn't load instances"));
    expect(radios(mounted)).toHaveLength(0);
    expect(text(mounted)).not.toContain('No CLI instances connected');
    const retry = Promise.withResolvers<{ instances: InstancePickerInstance[] }>();
    fetchInstances.mockReturnValue(retry.promise);
    press(mounted, row => row.accessibilityLabel === 'Retry');
    await waitFor(
      () => mounted.renderer.root.findAll(node => node.type === 'Skeleton').length === 8
    );
    await act(async () => {
      retry.resolve({ instances: [REMOTE] });
      await retry.promise;
    });
    await waitFor(() => radios(mounted).length === 2);
    expect(text(mounted)).not.toContain("Couldn't load instances");
  });

  it('keeps Cloud Agent in an empty result and disables Refresh while reloading', async () => {
    fetchInstances.mockResolvedValue({ instances: [] });
    const mounted = await openPicker(null);
    await waitFor(() => text(mounted).includes('No CLI instances connected'));
    expect(radios(mounted).map(row => row.accessibilityState?.checked)).toEqual([true]);
    expect(text(mounted)).not.toContain('Remotes');
    expect(text(mounted)).not.toContain('Terminals');
    const refresh = Promise.withResolvers<{ instances: InstancePickerInstance[] }>();
    fetchInstances.mockReturnValue(refresh.promise);
    press(mounted, row => row.accessibilityLabel === 'Refresh');
    await waitFor(() =>
      controls(mounted).some(row => row.accessibilityLabel === 'Refresh' && row.disabled === true)
    );
    expect(
      controls(mounted).find(row => row.accessibilityLabel === 'Refresh')?.accessibilityState?.busy
    ).toBe(true);
    await act(async () => {
      refresh.resolve({ instances: [REMOTE] });
      await refresh.promise;
    });
    await waitFor(() => radios(mounted).length === 2);
    expect(text(mounted)).toContain('Remotes');
    expect(text(mounted)).not.toContain('Terminals');
  });

  it('shows expired options without a fetch Retry and returns to the caller', async () => {
    const mounted = await mountScreen();
    expect(text(mounted)).toContain('Options expired');
    expect(text(mounted)).not.toContain('Retry');
    expect(radios(mounted)).toHaveLength(0);
    press(mounted, row => row.accessibilityLabel === 'Done');
    expect(navigation.current).toBe('caller');
  });

  it('dismisses without replacing the caller selection and clears the bridge on unmount', async () => {
    const mounted = await openPicker();
    await waitFor(() => radios(mounted).length === 5);
    press(mounted, row => row.accessibilityLabel === 'Done');
    mounted.unmount();
    expect(mounted.caller.selection).toBe(TERMINAL);
    expect(navigation.current).toBe('caller');
    expect(instancePickerSlot.get(UNFENCED_ROUTE_KEY)).toBeUndefined();
  });
});

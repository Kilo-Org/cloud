import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  type SandboxAllocation,
  type SandboxSelectionCapabilities,
} from '@/lib/sandbox-allocation-label';
import { type SandboxPickerBridge } from '@/lib/picker-bridge';

import SandboxPickerScreen from './sandbox-picker';

const router = vi.hoisted(() => ({ back: vi.fn() }));
const haptics = vi.hoisted(() => ({ selectionAsync: vi.fn() }));
const refetch = vi.hoisted(() => vi.fn());
const selection = vi.hoisted(() => ({
  capabilities: undefined as SandboxSelectionCapabilities | undefined,
  status: 'ready' as 'loading' | 'error' | 'ready',
  isFetching: false,
}));
const slot = vi.hoisted(() => ({
  bridge: undefined as SandboxPickerBridge | undefined,
  clear: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => router,
}));
vi.mock('expo-haptics', () => haptics);
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/lib/hooks/use-sandbox-selection', () => ({
  useSandboxSelection: () => ({
    capabilities: selection.capabilities,
    status: selection.status,
    isFetching: selection.isFetching,
    refetch,
    allocation: undefined,
    setAllocation: vi.fn(),
  }),
}));
vi.mock('@/components/picker-sheet', () => ({
  PickerSheet: (props: {
    title: string;
    onDone: () => void;
    onCancel?: () => void;
    expired?: boolean;
    scrollable?: boolean;
    children?: ReactNode;
  }) =>
    createElement(
      'PickerSheet',
      {
        title: props.title,
        expired: props.expired === true,
        scrollable: props.scrollable,
        onCancel: props.onCancel,
        onDone: props.onDone,
      },
      props.children
    ),
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { title: string; description: unknown; action?: ReactNode }) =>
    createElement('EmptyState', props, props.action),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/icons', () => ({ Cpu: 'Cpu', Check: 'Check', Info: 'Info' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#0a84ff', mutedForeground: '#666' }),
}));
vi.mock('@/lib/route-registry', () => ({
  UNFENCED_ROUTE_KEY: 'unscoped',
  useRouteRegistry: vi.fn(),
  sandboxPickerSlot: {
    get: () => slot.bridge,
    clear: slot.clear,
  },
}));

const CLOUDFLARE_SINGLE: SandboxAllocation = {
  provider: { id: 'cloudflare', account: 'kilo' },
  instanceType: 'single',
};
const CLOUDFLARE_SHARED: SandboxAllocation = {
  provider: { id: 'cloudflare', account: 'kilo' },
  instanceType: 'shared',
};
const VERCEL_LARGE: SandboxAllocation = {
  provider: { id: 'vercel', account: 'kilo' },
  instanceType: 'large',
};
const CAPABILITIES: SandboxSelectionCapabilities = {
  enabled: true,
  defaultDestination: CLOUDFLARE_SINGLE,
  options: [
    { allocation: CLOUDFLARE_SINGLE },
    { allocation: CLOUDFLARE_SHARED },
    { allocation: VERCEL_LARGE },
  ],
};

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}

function rows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => node.props.accessibilityRole === 'radio');
}

function row(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return rows(renderer).find(node => node.props.accessibilityLabel === label);
}

/** The checked flag each radio row carries, in render order. */
function checkedStates(renderer: TestRenderer.ReactTestRenderer): (boolean | undefined)[] {
  return rows(renderer).map(
    node =>
      (node.props as { accessibilityState?: { checked?: boolean } }).accessibilityState?.checked
  );
}

function press(node: TestRenderer.ReactTestInstance | undefined) {
  act(() => {
    (node?.props.onPress as (() => void) | undefined)?.();
  });
}

function mount(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(createElement(SandboxPickerScreen));
  });
  const created = ref.current;
  if (created === null) {
    throw new Error('the sandbox picker route did not render');
  }
  return created;
}

function setBridge(overrides: Partial<SandboxPickerBridge> = {}) {
  slot.bridge = {
    organizationId: undefined,
    options: CAPABILITIES.options,
    defaultDestination: CAPABILITIES.defaultDestination,
    currentValue: undefined,
    onSelect: vi.fn(() => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  slot.bridge = undefined;
  selection.capabilities = CAPABILITIES;
  selection.status = 'ready';
  selection.isFetching = false;
  router.back.mockClear();
  slot.clear.mockClear();
  refetch.mockClear();
  haptics.selectionAsync.mockClear();
});

describe('SandboxPickerScreen', () => {
  it('renders the backend default row and one radio row per offered allocation, grouped by provider', () => {
    setBridge();
    const renderer = mount();

    const shell = renderer.root.findByType('PickerSheet' as never);
    expect(shell.props.title).toBe(i18n.t('agentChat.newSession.sandbox'));

    const labels = rows(renderer).map(node => node.props.accessibilityLabel);
    expect(labels).toEqual([
      'Default · Cloudflare · Small',
      'Cloudflare · Small',
      'Cloudflare · Shared',
      'Vercel · Large',
    ]);
    // One group header per provider, in backend option order.
    expect(texts(renderer)).toContain('Cloudflare');
    expect(texts(renderer)).toContain('Vercel');
    // Nothing picked: the backend default is the checked row.
    expect(checkedStates(renderer)).toEqual([true, false, false, false]);
  });

  it('checks the picked allocation instead of the default row', () => {
    setBridge({ currentValue: VERCEL_LARGE });
    const renderer = mount();

    expect(checkedStates(renderer)).toEqual([false, false, false, true]);
    expect(row(renderer, 'Vercel · Large')?.props.accessibilityRole).toBe('radio');
  });

  it('hands the picked allocation back, clears the bridge, and dismisses', () => {
    const onSelect = vi.fn(() => undefined);
    setBridge({ onSelect });
    const renderer = mount();

    press(row(renderer, 'Vercel · Large'));

    expect(onSelect).toHaveBeenCalledWith(VERCEL_LARGE);
    expect(haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(slot.clear).toHaveBeenCalledWith('unscoped');
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('hands the backend default back when the default row is picked', () => {
    const onSelect = vi.fn(() => undefined);
    setBridge({ onSelect });
    const renderer = mount();

    press(row(renderer, 'Default · Cloudflare · Small'));

    expect(onSelect).toHaveBeenCalledWith(undefined);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('renders skeleton rows without rows or an empty result while the capabilities load', () => {
    selection.status = 'loading';
    selection.capabilities = undefined;
    setBridge();
    const renderer = mount();

    expect(renderer.root.findAllByType('Skeleton' as never)).toHaveLength(4);
    expect(rows(renderer)).toHaveLength(0);
    expect(texts(renderer)).not.toContain(i18n.t('agentChat.newSession.sandboxCouldNotLoad'));
  });

  it('renders the retryable failure with Retry and refetches', () => {
    selection.status = 'error';
    selection.capabilities = undefined;
    setBridge();
    const renderer = mount();

    const empty = renderer.root.findByType('EmptyState' as never);
    expect(empty.props.title).toBe(i18n.t('agentChat.newSession.sandboxCouldNotLoad'));
    const retry = renderer.root.findByType('Button' as never);
    expect(retry.props.accessibilityLabel).toBe(i18n.t('common.retry'));
    press(retry);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(rows(renderer)).toHaveLength(0);
  });

  it('renders the standard expired shell when the slot is gone', () => {
    const renderer = mount();

    const shell = renderer.root.findByType('PickerSheet' as never);
    expect(shell.props.expired).toBe(true);
    expect(rows(renderer)).toHaveLength(0);
  });
});

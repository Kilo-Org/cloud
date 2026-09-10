/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/attachment-preview-strip.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import BranchPickerScreen from './branch-picker';
import { type BranchPickerBridge } from '@/lib/picker-bridge';

const router = vi.hoisted(() => ({ back: vi.fn() }));
const slot = vi.hoisted(() => ({ bridge: undefined as BranchPickerBridge | undefined }));

vi.mock('expo-router', () => ({
  useRouter: () => router,
}));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@/components/picker-sheet', () => ({
  // The fake shell renders the header contract (title + both dismiss
  // controls) and the rows below it, so a test can assert the header
  // controls and the rows in one tree.
  PickerSheet: (props: {
    title: string;
    onDone: () => void;
    onCancel?: () => void;
    expired?: boolean;
    children?: React.ReactNode;
  }) =>
    createElement(
      'PickerSheet',
      {
        title: props.title,
        expired: props.expired === true,
        onCancel: props.onCancel,
        onDone: props.onDone,
      },
      props.children
    ),
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#0a84ff' }),
}));
vi.mock('@/lib/route-registry', () => ({
  UNFENCED_ROUTE_KEY: 'unscoped',
  useRouteRegistry: vi.fn(),
  branchPickerSlot: {
    get: () => slot.bridge,
    clear: vi.fn(),
  },
}));

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}

function branchLabel(branch: string): string {
  return i18n.t('agentChat.newSession.branchAccessibility', { label: branch });
}

function branchRow(renderer: TestRenderer.ReactTestRenderer, branch: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === branchLabel(branch) &&
      typeof node.props.onPress === 'function'
  )[0];
}

/** Fire a node's `onPress`, the way a tap would. */
function press(node: TestRenderer.ReactTestInstance | undefined) {
  act(() => {
    (node?.props.onPress as (() => void) | undefined)?.();
  });
}

/** Mount the screen inside act, so i18n's subscription settles inside it. */
function mount(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(createElement(BranchPickerScreen));
  });
  const created = ref.current;
  if (created === null) {
    throw new Error('the branch picker route did not render');
  }
  return created;
}

function setBridge(overrides: Partial<BranchPickerBridge> = {}) {
  slot.bridge = {
    branches: ['main', 'release/2.0'],
    defaultBranch: 'main',
    selectedBranch: 'main',
    onSelect: vi.fn(() => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  slot.bridge = undefined;
  router.back.mockClear();
});

describe('BranchPickerScreen', () => {
  it('renders the header shell with both dismiss controls and one row per branch', () => {
    setBridge();
    const renderer = mount();

    const shell = renderer.root.findByType('PickerSheet' as never);
    expect(shell.props.title).toBe(i18n.t('agentChat.newSession.branchPickerTitle'));
    expect(typeof shell.props.onCancel).toBe('function');
    expect(typeof shell.props.onDone).toBe('function');

    expect(branchRow(renderer, 'main')).toBeDefined();
    expect(branchRow(renderer, 'release/2.0')).toBeDefined();
  });

  it('marks the provider default row and the selected row', () => {
    setBridge({ selectedBranch: 'release/2.0' });
    const renderer = mount();

    expect(texts(renderer)).toContain(i18n.t('agentChat.newSession.branchDefault'));
    expect(branchRow(renderer, 'release/2.0')?.props.accessibilityState).toEqual({
      selected: true,
    });
    expect(branchRow(renderer, 'main')?.props.accessibilityState).toEqual({ selected: false });
  });

  it('hands the picked branch name back and dismisses', () => {
    const onSelect = vi.fn(() => undefined);
    setBridge({ onSelect });
    const renderer = mount();

    press(branchRow(renderer, 'release/2.0'));

    expect(onSelect).toHaveBeenCalledWith('release/2.0');
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('hands the default branch name back too — the trigger owns the override decision', () => {
    const onSelect = vi.fn(() => undefined);
    setBridge({ onSelect });
    const renderer = mount();

    press(branchRow(renderer, 'main'));

    expect(onSelect).toHaveBeenCalledWith('main');
  });

  it('dismisses from the header Cancel without reporting a pick', () => {
    const onSelect = vi.fn(() => undefined);
    setBridge({ onSelect });
    const renderer = mount();

    const shell = renderer.root.findByType('PickerSheet' as never);
    act(() => {
      (shell.props.onCancel as () => void)();
    });

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders the standard expired shell when the slot is gone', () => {
    const renderer = mount();

    const shell = renderer.root.findByType('PickerSheet' as never);
    expect(shell.props.expired).toBe(true);
    expect(texts(renderer)).not.toContain('main');
  });
});

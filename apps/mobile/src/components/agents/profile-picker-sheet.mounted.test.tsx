import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfilePickerSheet, type ProfilePickerSheetProps } from './profile-picker-sheet';
import { type SessionProfilePickerProfile } from './session-profile-picker-model';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/picker-sheet', () => ({
  PickerSheet: (props: {
    title: string;
    onDone: () => void;
    onCancel?: () => void;
    scrollable?: boolean;
    children?: ReactNode;
  }) =>
    createElement(
      'PickerSheet',
      {
        title: props.title,
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
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  Settings2: 'Settings2',
  SlidersHorizontal: 'SlidersHorizontal',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#0a84ff', mutedForeground: '#666', warn: '#956011' }),
}));

function profile(
  overrides: Partial<SessionProfilePickerProfile> & { id: string; name: string }
): SessionProfilePickerProfile {
  return {
    varCount: 0,
    mcpServerCount: 0,
    skillCount: 0,
    kiloCommandCount: 0,
    ...overrides,
  };
}

const BACKEND = profile({ id: 'backend', name: 'Backend', varCount: 3, mcpServerCount: 1 });
const FRONTEND = profile({ id: 'frontend', name: 'Frontend', skillCount: 2 });

function defaults(overrides: Partial<ProfilePickerSheetProps> = {}): ProfilePickerSheetProps {
  return {
    candidates: [BACKEND, FRONTEND],
    hasProfiles: true,
    selectedOverrideProfileId: null,
    isLoading: false,
    isError: false,
    needsAttention: false,
    onSelect: vi.fn<() => void>(),
    onManageProfiles: vi.fn<() => void>(),
    onRetry: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
    ...overrides,
  };
}

function mount(props: Partial<ProfilePickerSheetProps> = {}) {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(createElement(ProfilePickerSheet, defaults(props)));
  });
  const renderer = ref.current;
  if (renderer === null) {
    throw new Error('the picker did not render');
  }
  return renderer;
}

function radios(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => node.props.accessibilityRole === 'radio');
}

function radio(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return radios(renderer).find(node => node.props.accessibilityLabel === label);
}

function checkedStates(renderer: TestRenderer.ReactTestRenderer): (boolean | undefined)[] {
  return radios(renderer).map(
    node =>
      (node.props as { accessibilityState?: { checked?: boolean } }).accessibilityState?.checked
  );
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}

function press(node: TestRenderer.ReactTestInstance | undefined) {
  act(() => {
    (node?.props.onPress as (() => void) | undefined)?.();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ProfilePickerSheet', () => {
  it('offers a No profile row plus one checked row per candidate with counts', () => {
    const renderer = mount();

    expect(renderer.root.findByType('PickerSheet' as never).props.title).toBe('Pick a profile');
    expect(radios(renderer).map(node => node.props.accessibilityLabel)).toEqual([
      'No profile',
      'Backend',
      'Frontend',
    ]);
    expect(texts(renderer)).toContain('3 vars · 1 MCP');
    expect(checkedStates(renderer)).toEqual([true, false, false]);
  });

  it('checks the picked override row', () => {
    const renderer = mount({ selectedOverrideProfileId: 'frontend' });
    expect(checkedStates(renderer)).toEqual([false, false, true]);
  });

  it('selects a candidate, and clears it when the checked row is tapped again', () => {
    const onSelect = vi.fn<() => void>();
    const renderer = mount({ selectedOverrideProfileId: 'backend', onSelect });

    press(radio(renderer, 'Frontend'));
    expect(onSelect).toHaveBeenLastCalledWith('frontend');

    press(radio(renderer, 'Backend'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('selects No profile explicitly', () => {
    const onSelect = vi.fn<() => void>();
    const renderer = mount({ selectedOverrideProfileId: 'backend', onSelect });

    press(radio(renderer, 'No profile'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('leaves every row unchecked and shows the attention copy for a stale override', () => {
    const renderer = mount({ selectedOverrideProfileId: 'deleted', needsAttention: true });

    expect(checkedStates(renderer)).toEqual([false, false, false]);
    expect(texts(renderer)).toContain('Config needs attention');
  });

  it('renders skeleton rows while the profiles load', () => {
    const renderer = mount({ isLoading: true });

    expect(renderer.root.findAllByType('Skeleton' as never)).toHaveLength(4);
    expect(radios(renderer)).toHaveLength(0);
  });

  it('renders the retryable failure with Retry and refetches', () => {
    const onRetry = vi.fn<() => void>();
    const renderer = mount({ isError: true, onRetry });

    const empty = renderer.root.findByType('EmptyState' as never);
    expect(empty.props.title).toBe("Couldn't load your environment");
    const retry = renderer.root.findByType('Button' as never);
    expect(retry.props.accessibilityLabel).toBe('Retry');
    press(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(radios(renderer)).toHaveLength(0);
  });

  it('renders the empty state with the manage-profiles action', () => {
    const onManageProfiles = vi.fn<() => void>();
    const renderer = mount({ hasProfiles: false, candidates: [], onManageProfiles });

    const empty = renderer.root.findByType('EmptyState' as never);
    expect(empty.props.description).toBe(
      'No profiles yet. Create one to add environment variables, MCP servers, and skills.'
    );
    const manage = renderer.root.findByType('Button' as never);
    expect(manage.props.accessibilityLabel).toBe('Manage profiles');
    press(manage);
    expect(onManageProfiles).toHaveBeenCalledTimes(1);
    expect(radios(renderer)).toHaveLength(0);
  });

  it('keeps the manage entry available in the populated list', () => {
    const onManageProfiles = vi.fn<() => void>();
    const renderer = mount({ onManageProfiles });

    press(renderer.root.findByType('Button' as never));
    expect(onManageProfiles).toHaveBeenCalledTimes(1);
  });
});

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { buildActiveProfileIndicatorState } from './active-profile-indicator-model';
import { ActiveProfileIndicator } from './active-profile-indicator';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({
  SlidersHorizontal: 'SlidersHorizontal',
  Check: 'Check',
  Settings2: 'Settings2',
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ warn: '#956011', mutedForeground: '#6f6a61', foreground: '#14130f' }),
}));

function mount(
  state: Parameters<typeof ActiveProfileIndicator>[0]['state'],
  onPress = vi.fn<() => void>()
) {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(createElement(ActiveProfileIndicator, { state, onPress }));
  });
  const renderer = ref.current;
  if (renderer === null) {
    throw new Error('the indicator did not render');
  }
  return { renderer, onPress };
}

function pill(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType('Pressable' as never);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ActiveProfileIndicator', () => {
  it('renders nothing when there is no state', () => {
    const { renderer } = mount(null);
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders the label and names every layer in the accessibility label', () => {
    const state = buildActiveProfileIndicatorState({
      selectedProfileName: 'Backend',
      repoBoundProfileName: 'Repo profile',
      hasSelectedProfileId: true,
      hasManualEnvVars: false,
      hasManualSetupCommands: false,
    });
    const { renderer } = mount(state);

    const node = pill(renderer);
    expect(node.props.accessibilityRole).toBe('button');
    const label = node.props.accessibilityLabel as string;
    expect(label).toContain('Profiles active');
    expect(label).toContain('Repo profile: Repo profile');
    expect(label).toContain('Selected profile: Backend');
    expect(label).toContain('Open Settings to review');
    expect(renderer.root.findByType('SlidersHorizontal' as never)).toBeTruthy();
  });

  it('renders the amber attention treatment for the needs-attention state', () => {
    const state = buildActiveProfileIndicatorState({
      selectedProfileName: null,
      repoBoundProfileName: null,
      hasSelectedProfileId: true,
      hasManualEnvVars: false,
      hasManualSetupCommands: false,
    });
    const { renderer } = mount(state);

    const node = pill(renderer);
    expect(node.props.accessibilityLabel).toContain('Config needs attention');
    expect(node.props.className).toContain('border-warn-tile-border');
    expect(node.props.className).toContain('bg-warn-tile-bg');
  });

  it('calls onPress when tapped', () => {
    const { renderer, onPress } = mount(
      buildActiveProfileIndicatorState({
        selectedProfileName: 'Backend',
        repoBoundProfileName: null,
        hasSelectedProfileId: true,
        hasManualEnvVars: false,
        hasManualSetupCommands: false,
      })
    );

    act(() => {
      (pill(renderer).props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

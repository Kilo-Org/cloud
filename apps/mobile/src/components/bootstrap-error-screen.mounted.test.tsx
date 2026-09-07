/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as language-reload-error-screen.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BootstrapErrorScreen } from '@/components/bootstrap-error-screen';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
// The real Button stays mounted: the contract under test is its `loading`
// wiring (disabled + busy + inline spinner, button.tsx), not a mock of it.
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext(undefined) };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#000000', foreground: '#000000' }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function findPressableByAccessibilityLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance {
  const button = root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Pressable')
    .find(node => node.props.accessibilityLabel === label);
  if (!button) {
    throw new Error(`Pressable with accessibility label ${label} not found`);
  }
  return button;
}

function findLabel(root: TestRenderer.ReactTestInstance, label: string): boolean {
  return (
    root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.children === label
    ).length > 0
  );
}

async function mountScreen(primaryLoading?: boolean): Promise<{
  onPrimaryPress: ReturnType<typeof vi.fn<() => void>>;
  onSecondaryPress: ReturnType<typeof vi.fn<() => void>>;
  renderer: TestRenderer.ReactTestRenderer;
}> {
  const onPrimaryPress = vi.fn<() => void>();
  const onSecondaryPress = vi.fn<() => void>();
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(BootstrapErrorScreen, {
        title: 'Could not load your account',
        description: 'Something went wrong',
        primaryLabel: 'Retry',
        primaryAccessibilityLabel: 'Retry loading account',
        onPrimaryPress,
        primaryLoading,
        secondaryLabel: 'Sign out',
        secondaryAccessibilityLabel: 'Sign out',
        onSecondaryPress,
      })
    );
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return { onPrimaryPress, onSecondaryPress, renderer };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('BootstrapErrorScreen primaryLoading', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('renders an enabled primary button that fires onPrimaryPress without primaryLoading', async () => {
    const { onPrimaryPress, onSecondaryPress, renderer } = await mountScreen();

    const primary = findPressableByAccessibilityLabel(renderer.root, 'Retry loading account');
    expect(primary.props.disabled).toBe(false);
    expect(primary.props.accessibilityState).toEqual({ disabled: false, busy: undefined });
    expect(primary.props.className).not.toContain('opacity-50');
    expect(findLabel(renderer.root, 'Retry')).toBe(true);
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'ActivityIndicator'
      )
    ).toHaveLength(0);

    act(() => {
      (primary.props.onPress as () => void)();
    });
    expect(onPrimaryPress).toHaveBeenCalledTimes(1);
    expect(onSecondaryPress).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('renders the primary button busy and disabled with its label while primaryLoading, and keeps Sign out enabled', async () => {
    const { onPrimaryPress, onSecondaryPress, renderer } = await mountScreen(true);

    const primary = findPressableByAccessibilityLabel(renderer.root, 'Retry loading account');
    expect(primary.props.disabled).toBe(true);
    expect(primary.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(primary.props.className).toContain('opacity-50');
    // The busy indicator is the button's inline spinner; the label stays.
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'ActivityIndicator'
      )
    ).toHaveLength(1);
    expect(findLabel(renderer.root, 'Retry')).toBe(true);

    // The secondary Sign out button is the escape hatch: never disabled.
    const secondary = findPressableByAccessibilityLabel(renderer.root, 'Sign out');
    expect(secondary.props.disabled).toBe(false);
    act(() => {
      (secondary.props.onPress as () => void)();
    });
    expect(onSecondaryPress).toHaveBeenCalledTimes(1);
    expect(onPrimaryPress).not.toHaveBeenCalled();

    renderer.unmount();
  });
});

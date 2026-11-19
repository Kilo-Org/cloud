import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { BlockedAccountSurface } from '@/components/blocked-account-surface';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
// The real Button stays mounted: the contract under test is what the surface
// passes it (its label, its busy state), not a mock of the button.
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext(undefined) };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#000000', foreground: '#000000' }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const RETRY_LABEL = 'Retry loading account';

type SurfaceProps = {
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
  onSignOut: () => void;
};

function findPressables(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === 'Pressable');
}

function findPressableByAccessibilityLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance {
  const button = findPressables(root).find(node => node.props.accessibilityLabel === label);
  if (!button) {
    throw new Error(`Pressable with accessibility label ${label} not found`);
  }
  return button;
}

async function mountSurface(props: SurfaceProps): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(BlockedAccountSurface, props));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('BlockedAccountSurface', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('offers Retry that re-reads the account while the session exists', async () => {
    const onRetry = vi.fn<() => void>();
    const onSignOut = vi.fn<() => void>();
    const renderer = await mountSurface({
      canRetry: true,
      retrying: false,
      onRetry,
      onSignOut,
    });

    const retry = findPressableByAccessibilityLabel(renderer.root, RETRY_LABEL);
    expect(retry.props.disabled).toBe(false);
    // `retrying` is always a boolean, so the button renders its busy layout
    // in both states and reports `busy: false` while idle.
    expect(retry.props.accessibilityState).toEqual({ disabled: false, busy: false });

    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSignOut).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('shows Retry busy and disabled while a retry is in flight, keeping Sign out enabled', async () => {
    const renderer = await mountSurface({
      canRetry: true,
      retrying: true,
      onRetry: vi.fn<() => void>(),
      onSignOut: vi.fn<() => void>(),
    });

    const retry = findPressableByAccessibilityLabel(renderer.root, RETRY_LABEL);
    expect(retry.props.disabled).toBe(true);
    expect(retry.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'ActivityIndicator'
      )
    ).toHaveLength(1);
    const signOut = findPressableByAccessibilityLabel(renderer.root, 'Sign out');
    expect(signOut.props.disabled).toBe(false);

    renderer.unmount();
  });

  it('presses Sign out through to the caller', async () => {
    const onSignOut = vi.fn<() => void>();
    const renderer = await mountSurface({
      canRetry: true,
      retrying: false,
      onRetry: vi.fn<() => void>(),
      onSignOut,
    });

    const signOut = findPressableByAccessibilityLabel(renderer.root, 'Sign out');
    act(() => {
      (signOut.props.onPress as () => void)();
    });
    expect(onSignOut).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('renders no Retry when no session is left to re-read, and keeps Sign out', async () => {
    const onSignOut = vi.fn<() => void>();
    const renderer = await mountSurface({
      canRetry: false,
      retrying: false,
      onRetry: vi.fn<() => void>(),
      onSignOut,
    });

    expect(
      findPressables(renderer.root).some(node => node.props.accessibilityLabel === RETRY_LABEL)
    ).toBe(false);
    expect(findPressables(renderer.root)).toHaveLength(1);

    const signOut = findPressableByAccessibilityLabel(renderer.root, 'Sign out');
    act(() => {
      (signOut.props.onPress as () => void)();
    });
    expect(onSignOut).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});

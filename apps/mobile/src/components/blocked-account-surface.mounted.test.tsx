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
// passes it (its labels, its busy state, its order), not a mock of the button.
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext(undefined) };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#000000', foreground: '#000000' }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const RETRY_LABEL = 'Retry loading account';
const CONTACT_SUPPORT_LABEL = 'Contact support';
const SIGN_OUT_LABEL = 'Sign out';

type SurfaceProps = {
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
  onContactSupport: () => void;
  onSignOut: () => void;
};

function findPressables(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'Pressable'
  );
}

function pressableLabels(root: TestRenderer.ReactTestInstance): (string | undefined)[] {
  return findPressables(root).map(node => node.props.accessibilityLabel as string | undefined);
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

function press(root: TestRenderer.ReactTestInstance, label: string): void {
  const button = findPressableByAccessibilityLabel(root, label);
  act(() => {
    (button.props.onPress as () => void)();
  });
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

  it('offers Retry, Contact support and Sign out in that order while the session exists', async () => {
    const onRetry = vi.fn<() => void>();
    const onContactSupport = vi.fn<() => void>();
    const onSignOut = vi.fn<() => void>();
    const renderer = await mountSurface({
      canRetry: true,
      retrying: false,
      onRetry,
      onContactSupport,
      onSignOut,
    });

    expect(pressableLabels(renderer.root)).toEqual([
      RETRY_LABEL,
      CONTACT_SUPPORT_LABEL,
      SIGN_OUT_LABEL,
    ]);

    const retry = findPressableByAccessibilityLabel(renderer.root, RETRY_LABEL);
    expect(retry.props.disabled).toBe(false);
    // `retrying` is always a boolean, so the button renders its busy layout
    // in both states and reports `busy: false` while idle.
    expect(retry.props.accessibilityState).toEqual({ disabled: false, busy: false });

    press(renderer.root, RETRY_LABEL);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onContactSupport).not.toHaveBeenCalled();
    expect(onSignOut).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('shows Retry busy and disabled while a retry is in flight, keeping the other actions enabled', async () => {
    const renderer = await mountSurface({
      canRetry: true,
      retrying: true,
      onRetry: vi.fn<() => void>(),
      onContactSupport: vi.fn<() => void>(),
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
    expect(
      findPressableByAccessibilityLabel(renderer.root, CONTACT_SUPPORT_LABEL).props.disabled
    ).toBe(false);
    expect(findPressableByAccessibilityLabel(renderer.root, SIGN_OUT_LABEL).props.disabled).toBe(
      false
    );

    renderer.unmount();
  });

  it('presses Contact support through to the caller', async () => {
    const onContactSupport = vi.fn<() => void>();
    const onSignOut = vi.fn<() => void>();
    const renderer = await mountSurface({
      canRetry: true,
      retrying: false,
      onRetry: vi.fn<() => void>(),
      onContactSupport,
      onSignOut,
    });

    press(renderer.root, CONTACT_SUPPORT_LABEL);
    expect(onContactSupport).toHaveBeenCalledTimes(1);
    expect(onSignOut).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('presses Sign out through to the caller', async () => {
    const onContactSupport = vi.fn<() => void>();
    const onSignOut = vi.fn<() => void>();
    const renderer = await mountSurface({
      canRetry: true,
      retrying: false,
      onRetry: vi.fn<() => void>(),
      onContactSupport,
      onSignOut,
    });

    press(renderer.root, SIGN_OUT_LABEL);
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(onContactSupport).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('drops Retry when no session is left and keeps Contact support then Sign out', async () => {
    const onContactSupport = vi.fn<() => void>();
    const onSignOut = vi.fn<() => void>();
    const renderer = await mountSurface({
      canRetry: false,
      retrying: false,
      onRetry: vi.fn<() => void>(),
      onContactSupport,
      onSignOut,
    });

    expect(pressableLabels(renderer.root)).toEqual([CONTACT_SUPPORT_LABEL, SIGN_OUT_LABEL]);

    press(renderer.root, CONTACT_SUPPORT_LABEL);
    expect(onContactSupport).toHaveBeenCalledTimes(1);

    press(renderer.root, SIGN_OUT_LABEL);
    expect(onSignOut).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});

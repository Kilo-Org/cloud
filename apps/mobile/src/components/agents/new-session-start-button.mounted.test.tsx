import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import '@/i18n';

import { NewSessionStartButton } from './new-session-start-button';

// The real Button stays mounted: the contract under test is that the primary
// call-to-action keeps a visible label while starting (button.tsx draws the
// inline spinner, so an empty child renders as a bare brand-coloured bar).
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
// The real status component reaches `announceForA11y` (an iOS-only imperative
// bridge) and `Platform.OS`, neither of which this Node renderer provides; the
// stub mirrors its null-renders-nothing contract while keeping `message`
// inspectable.
vi.mock('@/components/ui/accessible-status', async () => {
  const { createElement: createHostElement } = await import('react');
  return {
    AccessibleStatus: ({ message }: { message: string | null }) =>
      message == null ? null : createHostElement('AccessibleStatus', { message }),
  };
});
// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose node_modules
// `.mjs` contains JSX this pipeline cannot transform. Provide a real context so
// Button's `useContext(TextClassContext)` still resolves.
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext(undefined) };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#000000', foreground: '#000000' }),
}));

type Instance = TestRenderer.ReactTestInstance;

function hostByType(root: Instance, type: string): Instance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function hasTextLabel(root: Instance, label: string): boolean {
  return hostByType(root, 'Text').some(node => node.props.children === label);
}

async function mountButton(props: {
  isCloneEntry?: boolean;
  isRemote?: boolean;
  isStartDisabled?: boolean;
  isStarting?: boolean;
  startBlockedReason?: string | null;
  startBlockedAction?: { label: string; onPress: () => void; isBusy?: boolean } | null;
}): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(NewSessionStartButton, {
        isCloneEntry: props.isCloneEntry ?? false,
        isRemote: props.isRemote ?? false,
        isStartDisabled: props.isStartDisabled ?? false,
        isStarting: props.isStarting ?? false,
        startBlockedReason: props.startBlockedReason ?? null,
        startBlockedAction: props.startBlockedAction ?? null,
        onStartSession: vi.fn<() => void>(),
      })
    );
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('NewSessionStartButton', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('shows the Start session label with no spinner when idle', async () => {
    const renderer = await mountButton({ isStarting: false });

    const button = hostByType(renderer.root, 'Pressable')[0];
    expect(button).toBeDefined();
    expect(button?.props.accessibilityState).toEqual({ disabled: false, busy: false });
    expect(hasTextLabel(renderer.root, 'Start session')).toBe(true);
    expect(hostByType(renderer.root, 'ActivityIndicator')).toHaveLength(0);

    renderer.unmount();
  });

  it('keeps the Starting… label beside the spinner and stays busy while starting', async () => {
    const renderer = await mountButton({ isStarting: true });

    const button = hostByType(renderer.root, 'Pressable')[0];
    expect(button).toBeDefined();
    // Busy (not disabled) primary keeps its brand fill instead of the muted one.
    expect(button?.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(button?.props.className).toContain('bg-primary');
    expect(hostByType(renderer.root, 'ActivityIndicator')).toHaveLength(1);
    // Regression: the ordinary branch rendered no text while starting, so the
    // full-width primary fill read as an empty bar with only a spinner dot.
    expect(hasTextLabel(renderer.root, 'Starting…')).toBe(true);
    expect(hasTextLabel(renderer.root, 'Start session')).toBe(false);

    renderer.unmount();
  });

  it('shows the Cloning session busy label for a local clone while starting', async () => {
    const renderer = await mountButton({ isCloneEntry: true, isRemote: false, isStarting: true });

    expect(hostByType(renderer.root, 'ActivityIndicator')).toHaveLength(1);
    expect(hasTextLabel(renderer.root, 'Cloning session')).toBe(true);

    renderer.unmount();
  });

  it('shows the blocked reason directly above Start for the ordinary entry', async () => {
    const renderer = await mountButton({
      isStartDisabled: true,
      startBlockedReason: 'Select a repository to start.',
    });

    const statuses = hostByType(renderer.root, 'AccessibleStatus');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.props.message).toBe('Select a repository to start.');

    // The reason renders directly above the Start control, never below it.
    const startOrder = renderer.root
      .findAll(node => {
        if (typeof node.type !== 'string') {
          return false;
        }
        const type = node.type as string;
        return type === 'AccessibleStatus' || type === 'Pressable';
      })
      .map(node => node.type as string);
    expect(startOrder).toEqual(['AccessibleStatus', 'Pressable']);

    renderer.unmount();
  });

  it('shows no reason when none is supplied', async () => {
    const renderer = await mountButton({});

    expect(hostByType(renderer.root, 'AccessibleStatus')).toHaveLength(0);
    expect(hostByType(renderer.root, 'Pressable')).toHaveLength(1);

    renderer.unmount();
  });

  it('shows the blocked reason above Start for the clone entry too', async () => {
    const renderer = await mountButton({
      isCloneEntry: true,
      isStartDisabled: true,
      startBlockedReason: 'Connect a provider to start.',
    });

    const statuses = hostByType(renderer.root, 'AccessibleStatus');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.props.message).toBe('Connect a provider to start.');

    renderer.unmount();
  });

  it('renders the recovery action between the reason and Start and fires onPress once', async () => {
    const onPress = vi.fn<() => void>();
    const renderer = await mountButton({
      isStartDisabled: true,
      startBlockedReason: 'Connect a provider to start.',
      startBlockedAction: { label: 'Connect a provider', onPress },
    });

    // Outline recovery button sits between the announced reason and Start.
    const order = renderer.root
      .findAll(node => {
        if (typeof node.type !== 'string') {
          return false;
        }
        const type = node.type as string;
        return type === 'AccessibleStatus' || type === 'Pressable';
      })
      .map(node => node.type as string);
    expect(order).toEqual(['AccessibleStatus', 'Pressable', 'Pressable']);

    const buttons = hostByType(renderer.root, 'Pressable');
    const actionButton = buttons[0];
    if (!actionButton) {
      throw new Error('recovery action button was not rendered');
    }
    expect(actionButton.props.accessibilityLabel).toBe('Connect a provider');
    expect(hasTextLabel(renderer.root, 'Connect a provider')).toBe(true);
    await act(async () => {
      (actionButton.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(onPress).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('renders no action while the reason is present but no action is supplied', async () => {
    const renderer = await mountButton({
      isStartDisabled: true,
      startBlockedReason: 'Select a repository to start.',
    });

    expect(hostByType(renderer.root, 'Pressable')).toHaveLength(1);
    expect(hasTextLabel(renderer.root, 'Connect a provider')).toBe(false);

    renderer.unmount();
  });

  it('disables the recovery action and shows the spinner while its work is in flight', async () => {
    const onPress = vi.fn<() => void>();
    const renderer = await mountButton({
      isStartDisabled: true,
      startBlockedReason: 'No repositories found',
      startBlockedAction: { label: 'Refresh repositories', onPress, isBusy: true },
    });

    const button = hostByType(renderer.root, 'Pressable')[0];
    expect(button?.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(hostByType(renderer.root, 'ActivityIndicator')).toHaveLength(1);

    renderer.unmount();
  });

  it('renders no action without a reason even when one is supplied', async () => {
    const renderer = await mountButton({
      startBlockedAction: { label: 'Connect a provider', onPress: vi.fn<() => void>() },
    });

    expect(hostByType(renderer.root, 'AccessibleStatus')).toHaveLength(0);
    expect(hostByType(renderer.root, 'Pressable')).toHaveLength(1);

    renderer.unmount();
  });
});

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
}): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(NewSessionStartButton, {
        isCloneEntry: props.isCloneEntry ?? false,
        isRemote: props.isRemote ?? false,
        isStartDisabled: props.isStartDisabled ?? false,
        isStarting: props.isStarting ?? false,
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
});

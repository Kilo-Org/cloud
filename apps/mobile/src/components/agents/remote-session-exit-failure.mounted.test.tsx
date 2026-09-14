/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as child-session-model-label.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { RemoteSessionExitFailure } from './remote-session-exit-failure';
import '@/i18n';

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));

// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose node_modules
// `.mjs` contains JSX that this pipeline cannot transform. Provide a real context
// so any `useContext(TextClassContext)` consumer still resolves.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    destructiveForeground: '#f00',
    foreground: '#000',
    mutedForeground: '#666',
    primaryForeground: '#fff',
  }),
}));

type RetryActionProps = {
  onPress: () => void;
  accessibilityState: { disabled?: boolean; busy?: boolean };
};

async function mount(isRetrying: boolean, onRetry: () => void) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      createElement(RemoteSessionExitFailure, {
        message: 'Failed to exit session',
        onRetry,
        isRetrying,
      })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function retryAction(renderer: TestRenderer.ReactTestRenderer): RetryActionProps {
  // Match the host Pressable, not the composite Button wrapper that passes the
  // label through without the accessibility state.
  const node = renderer.root
    .findAll(candidate => candidate.props.accessibilityLabel === 'Try again')
    .find(candidate => candidate.props.accessibilityState !== undefined);
  if (!node) {
    throw new Error('Try again action was not rendered');
  }
  return node.props as RetryActionProps;
}

describe('RemoteSessionExitFailure mounted', () => {
  it('renders the failure copy and an accessible Try again button', async () => {
    const onRetry = vi.fn<() => void>();
    const renderer = await mount(false, onRetry);

    expect(
      renderer.root.findAll(node => node.props.children === 'Failed to exit session')
    ).toHaveLength(1);

    const action = retryAction(renderer);
    expect(action.accessibilityState).toMatchObject({ disabled: false, busy: false });

    act(() => {
      action.onPress();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the retry as busy and disables the action while it runs', async () => {
    const renderer = await mount(true, vi.fn<() => void>());

    expect(retryAction(renderer).accessibilityState).toMatchObject({
      disabled: true,
      busy: true,
    });
  });
});

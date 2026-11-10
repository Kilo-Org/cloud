import { createElement, type ElementType, type ReactElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, expect, it, vi } from 'vitest';

import PrReviewNumberLayout from './_layout';

// The gate is the layout's own `screenLayout`; the unlock surface it wraps in
// production needs i18n, the native keychain and the unlock provider, none of
// which the gate reads, so the wrapper is replaced by its children here.
vi.mock('@/components/app-unlock-screen', () => ({
  appUnlockScreenLayout: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('@/components/centered-state-surface', () => ({
  NativeStateSurface: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/pr-review/pr-review-connect-gate', () => ({
  PrReviewConnectGate: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('@/components/use-feedback-prompt', () => ({
  FeedbackPromptProvider: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user' }),
}));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: () => undefined,
}));
vi.mock('@/lib/pr-review/pending-review-provider', () => ({
  pendingReviewDraftKey: (...parts: string[]) => parts.join(':'),
  PendingReviewProvider: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('@/lib/form-sheet', () => ({ useFormSheetScreenOptions: () => ({}) }));
vi.mock('react-native', () => ({ View: 'View' }));

/**
 * The scene's own navigation object: the nested Stack hands it to the layout,
 * not the parent navigator's, so the gate keyed on it reports this stack's
 * position. Emitting the event is what a push or sheet presentation does.
 */
const scene = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  let focused = true;
  const navigation = {
    isFocused: () => focused,
    addListener: (event: string, listener: () => void) => {
      const registered = listeners.get(event) ?? new Set<() => void>();
      registered.add(listener);
      listeners.set(event, registered);
      return () => registered.delete(listener);
    },
  };
  return {
    navigation,
    setFocused(next: boolean) {
      focused = next;
      const registered = listeners.get(next ? 'focus' : 'blur');
      if (registered) {
        for (const listener of registered) {
          listener();
        }
      }
    },
    listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
  };
});

vi.mock('expo-router', () => ({
  // The real Stack applies the layout it is given to the scene it mounts; the
  // declared screens are the routes it can present above that scene.
  Stack: Object.assign(
    ({
      screenLayout,
      children,
    }: {
      screenLayout: (props: unknown) => ReactElement;
      children?: ReactNode;
    }) =>
      createElement(
        'NestedNavigator',
        null,
        screenLayout({ navigation: scene.navigation, children: createElement('SceneBody') }),
        children
      ),
    { Screen: ({ name }: { name: string }) => createElement('RegisteredScreen', { name }) }
  ),
  useLocalSearchParams: () => ({ owner: 'owner', repo: 'repo', number: '7' }),
}));

const SceneBody = 'SceneBody' as ElementType;
const RegisteredScreen = 'RegisteredScreen' as ElementType;

function gate(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    node => (node.type as string) === 'View' && node.props.collapsable === false
  );
}

beforeEach(() => {
  scene.setFocused(true);
});

it('hides the PR review overview when a review sheet covers it', () => {
  const mounted: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    mounted.current = TestRenderer.create(createElement(PrReviewNumberLayout));
  });
  const renderer = mounted.current;
  if (!renderer) {
    throw new Error('renderer did not mount');
  }

  const navigator = renderer.root.findByType('NestedNavigator' as ElementType);
  expect(navigator.findByType(SceneBody)).toBeTruthy();
  expect(
    navigator.findAllByType(RegisteredScreen).map(node => node.props.name as string)
  ).toContain('comment-composer');
  expect(gate(renderer).props).toMatchObject({
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
  });

  act(() => {
    scene.setFocused(false);
  });
  expect(gate(renderer).props).toMatchObject({
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  });

  act(() => {
    scene.setFocused(true);
  });
  expect(gate(renderer).props).toMatchObject({
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
  });

  act(() => {
    renderer.unmount();
  });
  expect(scene.listenerCount()).toBe(0);
});

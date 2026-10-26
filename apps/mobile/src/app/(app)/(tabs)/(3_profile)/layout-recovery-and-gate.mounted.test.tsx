import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, expect, it, vi } from 'vitest';

import ProfileLayout from './_layout';

// The tab's recovery boundary owns the error surface and its reads, which its
// own suite covers. Here it must only still wrap the navigator: a screen throw
// has to reach it while the scene gate under the Stack hides covered scenes.
vi.mock('@/components/tab-stack-error-boundary', () => ({
  TabStackErrorBoundary: ({ children }: { children: ReactElement }) =>
    createElement('TabStackErrorBoundary', null, children),
}));
vi.mock('@/components/app-unlock-screen', () => ({
  appUnlockScreenLayout: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('@/components/centered-state-surface', () => ({
  NativeStateSurface: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: () => undefined,
}));

/**
 * The scene's own navigation object, handed to the layout by the stack. The
 * tab stack's own layout mounts this one, so the gate must sit inside the
 * recovery boundary rather than above it: the boundary replaces the navigator
 * on a throw, and the gate keeps applying to the scenes the navigator mounts.
 */
const scene = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let focused = true;
  return {
    setFocused(next: boolean) {
      focused = next;
      for (const listener of listeners) {
        listener();
      }
    },
    navigation: {
      isFocused: () => focused,
      addListener: (_event: string, listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
});

vi.mock('expo-router', () => ({
  // The real Stack applies the scene layout it is given to each scene it keeps.
  Stack: Object.assign(
    ({ screenLayout }: { screenLayout: (props: unknown) => ReactElement }) =>
      createElement(
        'TabStack',
        null,
        screenLayout({ navigation: scene.navigation, children: createElement('SceneBody') })
      ),
    { Screen: ({ name }: { name: string }) => createElement('RegisteredScreen', { name }) }
  ),
  // The tab root settles its switch-input window on focus.
  useFocusEffect: () => undefined,
}));

function mount() {
  const mounted: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    mounted.current = TestRenderer.create(createElement(ProfileLayout));
  });
  const renderer = mounted.current;
  if (!renderer) {
    throw new Error('renderer did not mount');
  }
  return renderer;
}

function gate(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    node => (node.type as string) === 'View' && node.props.collapsable === false
  );
}

beforeEach(() => {
  scene.setFocused(true);
});

it('keeps the recovery boundary around the navigator that the gate covers', () => {
  const renderer = mount();
  const boundary = renderer.root.findByType('TabStackErrorBoundary' as never);
  expect(boundary.findAllByType('TabStack' as never).length).toBe(1);
  expect(boundary.findAllByType('SceneBody' as never).length).toBe(1);
  expect(gate(renderer).props).toMatchObject({
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
  });
  act(() => {
    renderer.unmount();
  });
});

it('hides the covered scene inside the boundary and restores it on focus', () => {
  const renderer = mount();
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
});

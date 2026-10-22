import { createElement } from 'react';
import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { expect, it, vi } from 'vitest';

import { appScreenLayout } from '@/components/app-screen-layout';
import { type ScreenLayoutProps } from '@/components/centered-state-surface';

// The gate reads nothing else from React Native, and the mounted project cannot
// parse the library's Flow-typed source: the wrapper is a plain host element.
vi.mock('react-native', () => ({ View: 'View' }));

// The unlock surface is not under test here; the gate wraps it, so the scene
// body is whatever the layout passed and the wrapper is the only thing asserted.
vi.mock('@/components/app-unlock-screen', () => ({
  appUnlockScreenLayout: ({ children }: { children: unknown }) => children,
}));
// The gate module also installs itself around the measured state surface for
// the pre-auth stack; that surface needs native measurement, not under test.
vi.mock('@/components/centered-state-surface', () => ({
  NativeStateSurface: ({ children }: { children: unknown }) => children,
}));

type FocusListener = () => void;

/** The scene's own navigation object, as the native Stack hands it to a layout. */
function fakeSceneNavigation(initiallyFocused = true) {
  const listeners = new Map<string, Set<FocusListener>>();
  let focused = initiallyFocused;
  return {
    navigation: {
      isFocused: () => focused,
      addListener: (event: string, listener: FocusListener) => {
        const set = listeners.get(event) ?? new Set<FocusListener>();
        set.add(listener);
        listeners.set(event, set);
        return () => {
          set.delete(listener);
        };
      },
    },
    // Drives the event the native Stack sends: a push blurs the covered scene,
    // a pop focuses it again.
    setFocused(next: boolean) {
      focused = next;
      for (const listener of listeners.get(next ? 'focus' : 'blur') ?? []) {
        listener();
      }
    },
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
  };
}

async function mountScene(initiallyFocused: boolean) {
  const scene = fakeSceneNavigation(initiallyFocused);
  // The fake supplies the two fields the gate reads; the Stack's route, options
  // and theme are not part of this contract.
  const props = { navigation: scene.navigation, children: createElement('Draft') };
  const view = await renderWithProviders(
    createElement(appScreenLayout, props as unknown as ScreenLayoutProps)
  );
  const gate = () =>
    view.renderer.root.find(
      node => (node.type as string) === 'View' && node.props.collapsable === false
    );
  return { gate, scene, view };
}

it('exposes a focused scene and hides it while another screen covers it', async () => {
  const { gate, scene, view } = await mountScene(true);
  expect(gate().props).toMatchObject({
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
  });

  act(() => {
    scene.setFocused(false);
  });
  expect(gate().props).toMatchObject({
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  });

  act(() => {
    scene.setFocused(true);
  });
  expect(gate().props).toMatchObject({
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
  });

  view.unmount();
  expect(scene.listenerCount()).toBe(0);
});

it('mounts a covered scene hidden until it becomes the visible one', async () => {
  const { gate, scene } = await mountScene(false);
  expect(gate().props).toMatchObject({
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  });

  act(() => {
    scene.setFocused(true);
  });
  expect(gate().props).toMatchObject({
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
  });
});

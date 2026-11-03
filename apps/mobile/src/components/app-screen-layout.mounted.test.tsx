import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { expect, it, vi } from 'vitest';

import { appScreenLayout } from '@/components/app-screen-layout';
import { type ScreenLayoutProps } from '@/components/centered-state-surface';
import { armLeaveSettle, insideLeaveSettle, resetLeaveSettle } from '@/lib/navigation/leave-settle';

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

type SceneListener = (event?: { data?: { closing: boolean } }) => void;

/** The scene's own navigation object, as the native Stack hands it to a layout. */
function fakeSceneNavigation(initiallyFocused = true) {
  const listeners = new Map<string, Set<SceneListener>>();
  let focused = initiallyFocused;
  return {
    navigation: {
      isFocused: () => focused,
      addListener: (event: string, listener: SceneListener) => {
        const set = listeners.get(event) ?? new Set<SceneListener>();
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
    // Drives the native transition's end for this scene, `closing` when it is
    // this scene that left.
    finishTransition(closing: boolean) {
      for (const listener of listeners.get('transitionEnd') ?? []) {
        listener({ data: { closing } });
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

it('follows the scene navigation it is replaced with instead of the old one', async () => {
  const first = fakeSceneNavigation(true);
  const second = fakeSceneNavigation(true);
  const sceneElement = (navigation: unknown) =>
    createElement(appScreenLayout, {
      navigation,
      children: createElement('Draft'),
    } as unknown as ScreenLayoutProps);
  const view = await renderWithProviders(sceneElement(first.navigation));
  const gate = () =>
    view.renderer.root.find(
      node => (node.type as string) === 'View' && node.props.collapsable === false
    );

  act(() => {
    view.renderer.update(
      createElement(
        QueryClientProvider,
        { client: view.queryClient },
        sceneElement(second.navigation)
      )
    );
  });

  // A leftover listener on the replaced navigator would hide or expose this
  // scene for another scene's focus change.
  expect(first.listenerCount()).toBe(0);
  act(() => {
    second.setFocused(false);
  });
  expect(gate().props).toMatchObject({
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  });

  view.unmount();
  expect(second.listenerCount()).toBe(0);
});

it('ends a dismissal’s settle window when this scene finishes appearing', async () => {
  const { scene, view } = await mountScene(true);
  armLeaveSettle();
  expect(insideLeaveSettle()).toBe(true);

  // A scene that appears carries the screen that dismissed itself away, so its
  // own transition's end is the end of that leave.
  act(() => {
    scene.finishTransition(false);
  });
  expect(insideLeaveSettle()).toBe(false);

  armLeaveSettle();
  // A scene that leaves is not the one a dismissal revealed.
  act(() => {
    scene.finishTransition(true);
  });
  expect(insideLeaveSettle()).toBe(true);

  view.unmount();
  resetLeaveSettle();
});

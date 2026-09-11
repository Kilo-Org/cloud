/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement, type ElementType } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import { TourScreen } from './tour-screen';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const routerBack = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const recordCompleted = vi.hoisted(() => vi.fn());
const completionState = vi.hoisted(() => ({ isLoaded: true, isCompleted: false }));
// Models React Native's BackHandler as a set of live subscriptions so a test
// can press Back and observe exactly which listeners are registered.
const backHandler = vi.hoisted(() => {
  const handlers = new Set<() => boolean>();
  return {
    handlers,
    add: (handler: () => boolean) => {
      handlers.add(handler);
      return {
        remove: () => {
          handlers.delete(handler);
        },
      };
    },
    press: () => {
      let handled = false;
      for (const handler of handlers) {
        handled = handler() || handled;
      }
      return handled;
    },
    reset: () => {
      handlers.clear();
    },
  };
});
// Drives the tour route's focus: the shell registers its Back interception in
// `useFocusEffect`, so flipping this re-runs the effect like a real blur/focus.
const focusState = vi.hoisted(() => ({ active: true }));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => backHandler.add(handler),
  },
}));

vi.mock('expo-router', async () => {
  const { useEffect } = await vi.importActual<{
    useEffect: (effect: () => undefined | (() => void), deps: readonly unknown[]) => void;
  }>('react');
  return {
    useRouter: () => ({ back: routerBack, push: routerPush }),
    // `useFocusEffect` runs the callback while the route is focused and tears
    // it down on blur, matching React Navigation.
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const isFocused = focusState.active;
      useEffect(() => {
        if (!isFocused) {
          return undefined;
        }
        return effect();
      }, [effect, isFocused]);
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));

vi.mock('@/lib/tour/tour-completion', () => ({
  useTourCompletion: () => ({
    isLoaded: completionState.isLoaded,
    isCompleted: completionState.isCompleted,
    recordCompleted,
  }),
}));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Cloud: 'Cloud',
  Monitor: 'Monitor',
  Sparkles: 'Sparkles',
}));

// The chosen path's step is replaced with a controllable stub that exposes
// `onCompletedChange`, so the shell contract is tested without the step's
// network behavior.
vi.mock('./tour-cloud-step', () => ({ TourCloudStep: 'TourCloudStep' }));
vi.mock('./tour-remote-step', () => ({ TourRemoteStep: 'TourRemoteStep' }));

// ── Helpers ────────────────────────────────────────────────────────────────

type Renderer = Awaited<ReturnType<typeof renderWithProviders>>['renderer'];

function childValues(node: { children?: unknown }): unknown[] {
  return Array.isArray(node.children) ? node.children : [node.children];
}

function hasText(renderer: Renderer, value: string): boolean {
  return renderer.root
    .findAllByType('Text' as ElementType)
    .some(node => childValues(node).includes(value));
}

function findControl(
  renderer: Renderer,
  type: string,
  label: string
): ReactTestInstance | undefined {
  return renderer.root
    .findAllByType(type as ElementType)
    .find(control =>
      control.findAllByType('Text' as ElementType).some(node => childValues(node).includes(label))
    );
}

function requireControl(renderer: Renderer, type: string, label: string): ReactTestInstance {
  const control = findControl(renderer, type, label);
  if (!control) {
    throw new Error(`control not found: ${type} "${label}"`);
  }
  return control;
}

function pressControl(renderer: Renderer, type: string, label: string): void {
  const control = requireControl(renderer, type, label);
  act(() => {
    (control.props as { onPress?: () => void }).onPress?.();
  });
}

function reportCompletion(renderer: Renderer, type: string, completed: boolean): void {
  const step = renderer.root.findByType(type as ElementType);
  act(() => {
    (step.props as { onCompletedChange: (value: boolean) => void }).onCompletedChange(completed);
  });
}

async function mountTour() {
  const mounted = await renderWithProviders(createElement(TourScreen));
  return mounted;
}

type MountedTour = Awaited<ReturnType<typeof mountTour>>;

/** Re-render the same tour instance, e.g. after the route's focus changes. */
function rerenderTour(mounted: MountedTour): void {
  act(() => {
    mounted.renderer.update(
      createElement(QueryClientProvider, { client: mounted.queryClient }, createElement(TourScreen))
    );
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('TourScreen', () => {
  beforeEach(() => {
    routerBack.mockReset();
    routerPush.mockReset();
    recordCompleted.mockReset();
    backHandler.reset();
    focusState.active = true;
    completionState.isLoaded = true;
    completionState.isCompleted = false;
  });

  it('renders the fork question and both path cards', async () => {
    const { renderer, unmount } = await mountTour();

    expect(hasText(renderer, 'tour.forkTitle')).toBe(true);
    expect(hasText(renderer, 'tour.forkSubtitle')).toBe(true);
    expect(hasText(renderer, 'tour.cloudOptionTitle')).toBe(true);
    expect(hasText(renderer, 'tour.remoteOptionTitle')).toBe(true);
    expect(renderer.root.findAllByType('TourCloudStep' as ElementType)).toHaveLength(0);
    expect(renderer.root.findAllByType('TourRemoteStep' as ElementType)).toHaveLength(0);

    unmount();
  });

  it('renders the matching step after a card is chosen', async () => {
    const { renderer, unmount } = await mountTour();

    pressControl(renderer, 'ChoiceRow', 'tour.cloudOptionTitle');

    expect(renderer.root.findAllByType('TourCloudStep' as ElementType)).toHaveLength(1);
    expect(renderer.root.findAllByType('TourRemoteStep' as ElementType)).toHaveLength(0);
    expect(hasText(renderer, 'tour.forkTitle')).toBe(false);

    unmount();
  });

  it('records the decision and dismisses on Skip', async () => {
    const { renderer, unmount } = await mountTour();

    pressControl(renderer, 'Button', 'tour.skip');

    expect(recordCompleted).toHaveBeenCalledTimes(1);
    expect(routerBack).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('keeps Skip available and Done disabled until the step reports completion', async () => {
    const { renderer, unmount } = await mountTour();

    pressControl(renderer, 'ChoiceRow', 'tour.cloudOptionTitle');

    // Skip stays available on the chosen path even before completion.
    expect(findControl(renderer, 'Button', 'tour.skip')).toBeDefined();
    expect(requireControl(renderer, 'Button', 'common.done').props).toMatchObject({
      disabled: true,
    });

    reportCompletion(renderer, 'TourCloudStep', true);

    expect(requireControl(renderer, 'Button', 'common.done').props).toMatchObject({
      disabled: false,
    });
    expect(recordCompleted).not.toHaveBeenCalled();

    pressControl(renderer, 'Button', 'common.done');
    expect(recordCompleted).toHaveBeenCalledTimes(1);
    expect(routerBack).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('records the decision and dismisses on Android hardware Back', async () => {
    const { unmount } = await mountTour();

    expect(backHandler.handlers.size).toBe(1);
    let handled = false;
    act(() => {
      handled = backHandler.press();
    });

    expect(handled).toBe(true);
    expect(recordCompleted).toHaveBeenCalledTimes(1);
    expect(routerBack).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('stops intercepting Back once a step pushes its own screen on top', async () => {
    const mounted = await mountTour();
    const { unmount } = mounted;

    // The cloud step's New-session form pushes on top of the tour: the tour
    // route blurs, so its Back interception must be released. Back on that
    // form is the form's, and cancelling it is not a tour dismissal.
    focusState.active = false;
    rerenderTour(mounted);

    expect(backHandler.handlers.size).toBe(0);
    let handled = false;
    act(() => {
      handled = backHandler.press();
    });
    expect(handled).toBe(false);
    expect(recordCompleted).not.toHaveBeenCalled();
    expect(routerBack).not.toHaveBeenCalled();

    // Returning to the tour re-arms the interception.
    focusState.active = true;
    rerenderTour(mounted);

    expect(backHandler.handlers.size).toBe(1);
    act(() => {
      backHandler.press();
    });
    expect(recordCompleted).toHaveBeenCalledTimes(1);
    expect(routerBack).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('replays the tour after the account already finished it', async () => {
    completionState.isCompleted = true;
    const { renderer, unmount } = await mountTour();

    // Not gated on the stored decision: the Profile replay renders the fork.
    expect(hasText(renderer, 'tour.forkTitle')).toBe(true);

    pressControl(renderer, 'ChoiceRow', 'tour.remoteOptionTitle');
    expect(renderer.root.findAllByType('TourRemoteStep' as ElementType)).toHaveLength(1);

    reportCompletion(renderer, 'TourRemoteStep', true);
    expect(requireControl(renderer, 'Button', 'common.done').props).toMatchObject({
      disabled: false,
    });

    unmount();
  });
});

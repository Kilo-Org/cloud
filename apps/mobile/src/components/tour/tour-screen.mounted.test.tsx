import { createElement, type ElementType } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HOME_TAB_ROOT } from '@/lib/tour/tour-dismiss';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TourScreen } from './tour-screen';
import { TourStepHeader } from './tour-step-header';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const routerBack = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
// The hand-off's router. A literal `router.replace` swaps the tour and the
// new-session page in one native-stack commit, which crashes Android Fabric
// (KILO-APP-25), so the shell must route the hand-off through the stack-safe
// replace instead.
const stackSafeReplace = vi.hoisted(() => vi.fn());
// Models the navigator's own history: false means the tour is the app's first
// route, where a GO_BACK has nothing to pop.
const routerCanGoBack = vi.hoisted(() => ({ value: true }));
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
      return { remove: () => handlers.delete(handler) };
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
  ScrollView: 'ScrollView',
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => backHandler.add(handler),
  },
}));

vi.mock('expo-router', async () => {
  const { useEffect } = await vi.importActual<{
    useEffect: (effect: () => undefined | (() => void), deps: readonly unknown[]) => void;
  }>('react');
  return {
    useRouter: () => ({
      back: routerBack,
      replace: routerReplace,
      canGoBack: () => routerCanGoBack.value,
    }),
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

// The push + post-transition cleanup that keeps Android's native stack alive is
// covered by src/lib/navigation/stack-safe-replace.mounted.test.tsx; here it
// stands in so the shell's hand-off can be asserted to use it (and not a
// literal `router.replace`, which is what KILO-APP-25 crashed on).
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: stackSafeReplace }),
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

// Mocked to a host string so the fork-body assertion below can actually match
// it: an unmocked component is a function, and `findAllByType` by string never
// finds it, so the check would pass no matter what the shell rendered.
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Cloud: 'Cloud',
  Monitor: 'Monitor',
  Sparkles: 'Sparkles',
}));

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

function requireControl(renderer: Renderer, type: string, label: string): ReactTestInstance {
  const control = renderer.root
    .findAllByType(type as ElementType)
    .find(node =>
      node.findAllByType('Text' as ElementType).some(entry => childValues(entry).includes(label))
    );
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
    routerReplace.mockReset();
    stackSafeReplace.mockReset();
    routerCanGoBack.value = true;
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

    // The screen header keeps only the native modal spacing. The eyebrow sits
    // in the centered step header, directly above the heading it names.
    const screenHeader = renderer.root.findByType('ScreenHeader' as ElementType);
    expect(screenHeader.props).not.toHaveProperty('eyebrow');
    expect(renderer.root.findByType(TourStepHeader).props.eyebrow).toBe('tour.eyebrow');

    unmount();
  });

  it('centres the fork body in the band between the header and the Skip bar', async () => {
    const { renderer, unmount } = await mountTour();

    // One ScrollView owns the fork body. Its content container grows to the
    // viewport (`grow`) and distributes the header and the two path cards in
    // the middle (`justify-center`), so the block fills the band between the
    // header and the Skip bar instead of leaving the empty lower half the owner
    // reported. `grow` is a minimum, so taller content still scrolls rather
    // than being clipped.
    const scroller = renderer.root.findByType('ScrollView' as ElementType);
    expect(scroller.props.contentContainerClassName).toBe('grow justify-center gap-8 px-6 py-6');
    expect(renderer.root.findAllByType('CenteredState' as ElementType)).toHaveLength(0);

    unmount();
  });

  it('keeps modal spacing without moving the eyebrow out of the step header', async () => {
    const { renderer, unmount } = await mountTour();

    const header = renderer.root.findByProps({ modal: true });
    expect(header.props.showBackButton).toBe(false);
    expect(header.props.eyebrow).toBeUndefined();
    expect(renderer.root.findByType(TourStepHeader).props.eyebrow).toBe('tour.eyebrow');

    unmount();
  });

  it('hands off to the new-session page with Cloud Agent preselected', async () => {
    const { renderer, unmount } = await mountTour();

    pressControl(renderer, 'ChoiceRow', 'tour.cloudOptionTitle');

    // The Cloud card does not open a step: it completes the tour by handing
    // straight to the form, and it never pops the tour.
    expect(recordCompleted).toHaveBeenCalledTimes(1);
    // The hand-off goes through the stack-safe replace, not a literal
    // `router.replace`, so the tour and the form never swap in one commit.
    expect(stackSafeReplace).toHaveBeenCalledTimes(1);
    expect(stackSafeReplace).toHaveBeenCalledWith('/(app)/agent-chat/new?preselectRunOn=cloud');
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerBack).not.toHaveBeenCalled();

    unmount();
  });

  it('hands off to the new-session page with no preselect when the computer card is chosen', async () => {
    const { renderer, unmount } = await mountTour();

    pressControl(renderer, 'ChoiceRow', 'tour.remoteOptionTitle');

    // The computer card records the decision and hands straight to the form
    // too. It passes no run-on param, so the form restores the stored run-on
    // preference and the person picks their computer there.
    expect(recordCompleted).toHaveBeenCalledTimes(1);
    expect(stackSafeReplace).toHaveBeenCalledTimes(1);
    expect(stackSafeReplace).toHaveBeenCalledWith('/(app)/agent-chat/new');
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerBack).not.toHaveBeenCalled();

    unmount();
  });

  it('records the decision and dismisses on Skip', async () => {
    const { renderer, unmount } = await mountTour();

    pressControl(renderer, 'Button', 'tour.skip');

    expect(recordCompleted).toHaveBeenCalledTimes(1);
    expect(routerBack).toHaveBeenCalledTimes(1);
    expect(routerReplace).not.toHaveBeenCalled();

    unmount();
  });

  it('lands on Home instead of an unhandled GO_BACK when nothing is beneath the tour', async () => {
    // A tour reached as the app's first route (deep link / restored pending
    // navigation) has no screen to pop: an unguarded `router.back()` would
    // dispatch a GO_BACK nothing handles, leaving the modal up behind the
    // development-only banner. Skip and hard Back land on Home instead.
    routerCanGoBack.value = false;
    const { renderer, unmount } = await mountTour();

    pressControl(renderer, 'Button', 'tour.skip');

    expect(recordCompleted).toHaveBeenCalledTimes(1);
    expect(routerBack).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledWith(HOME_TAB_ROOT);

    // Hardware Back dismisses through the same guarded path.
    act(() => {
      backHandler.press();
    });
    expect(routerBack).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalledTimes(2);

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

  it('stops intercepting Back once the tour route loses focus', async () => {
    const mounted = await mountTour();
    const { unmount } = mounted;

    // The hand-off replaces the tour route and Skip pops it, so the tour blurs:
    // its Back interception must be released with the route.
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
    expect(recordCompleted).toHaveBeenCalledTimes(1);
    expect(stackSafeReplace).toHaveBeenCalledWith('/(app)/agent-chat/new');

    unmount();
  });
});

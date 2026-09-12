/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TourAutoOpen } from './tour-auto-open';

const routerPush = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  userId: 'user-1' as string | undefined,
  isLoaded: true,
  isCompleted: false,
  pathname: '/(app)/(tabs)/(0_home)',
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
  usePathname: () => state.pathname,
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: state.userId }),
}));

vi.mock('@/lib/tour/tour-completion', () => ({
  useTourCompletion: () => ({
    isLoaded: state.isLoaded,
    isCompleted: state.isCompleted,
    recordCompleted: vi.fn(),
  }),
}));

function mountAutoOpen(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(TourAutoOpen));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

// Re-render the same root: the component instance (and its once-only ref) is
// preserved, so this exercises "later renders must not re-open the tour".
function rerender(renderer: TestRenderer.ReactTestRenderer) {
  act(() => {
    renderer.update(createElement(TourAutoOpen));
  });
}

describe('TourAutoOpen', () => {
  beforeEach(() => {
    routerPush.mockReset();
    state.userId = 'user-1';
    state.isLoaded = true;
    state.isCompleted = false;
    state.pathname = '/(app)/(tabs)/(0_home)';
  });

  it('pushes the tour exactly once on a first sign-in that has not completed it', () => {
    const renderer = mountAutoOpen();

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/(app)/tour');

    // A later render for the same account must not re-open the tour.
    rerender(renderer);
    expect(routerPush).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('never pushes once the account has finished or skipped the tour', () => {
    state.isCompleted = true;
    const renderer = mountAutoOpen();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('never pushes while signed out', () => {
    state.userId = undefined;
    state.isLoaded = false;
    const renderer = mountAutoOpen();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('never pushes before the stored decision has loaded', () => {
    state.isLoaded = false;
    const renderer = mountAutoOpen();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('does not push when the tour route is already active and never pushes later', () => {
    state.pathname = '/(app)/tour';
    const renderer = mountAutoOpen();

    expect(routerPush).not.toHaveBeenCalled();

    // The person dismissed the tour (or opened it from Profile); navigating
    // away must not push it behind them.
    state.pathname = '/(app)/(tabs)/(3_profile)';
    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  // A brand-new account signs in behind the consent gate; its bootstrap guard
  // replaces any other route back to the gate, so a tour pushed from the gate
  // is undone within a frame. The once-only marker must survive that bounce and
  // the tour must open as soon as the gate is answered.
  it('holds the once-only marker through the consent gate and opens after it', () => {
    state.pathname = '/consent';
    const renderer = mountAutoOpen();

    expect(routerPush).not.toHaveBeenCalled();

    // Answering the gate lands on Home; the tour opens then, exactly once.
    state.pathname = '/(app)/(tabs)/(0_home)';
    rerender(renderer);
    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/(app)/tour');

    rerender(renderer);
    expect(routerPush).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});

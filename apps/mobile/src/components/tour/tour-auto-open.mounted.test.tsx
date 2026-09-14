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

type ConsentChange = { userId: string; hasAccepted: boolean; optional: boolean };

// A controllable consent gate. `gate.result` is what the initial read
// resolves to; `emit` drives the same change notification a consent write
// raises, so a test can answer the gate.
const consent = vi.hoisted(() => {
  const gate = {
    result: { status: 'accepted' as 'accepted' | 'needs-consent' | 'error', optional: false },
    listeners: new Set<(change: ConsentChange) => void>(),
  };
  return {
    gate,
    emit: (change: ConsentChange) => {
      for (const listener of gate.listeners) {
        listener(change);
      }
    },
    reset: () => {
      gate.result = { status: 'accepted', optional: false };
      gate.listeners.clear();
    },
  };
});

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

vi.mock('@/lib/consent-gate', () => ({
  checkConsentGate: async () => {
    await Promise.resolve();
    return consent.gate.result;
  },
}));

vi.mock('@/lib/consent', () => ({
  subscribeToConsentChanges: (listener: (change: ConsentChange) => void) => {
    consent.gate.listeners.add(listener);
    return () => {
      consent.gate.listeners.delete(listener);
    };
  },
}));

/** Flushes the consent read and the re-render it schedules. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountAutoOpen(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(TourAutoOpen));
  });
  await settle();
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
    consent.reset();
  });

  it('pushes the tour exactly once on a first sign-in that has not completed it', async () => {
    const renderer = await mountAutoOpen();

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/(app)/tour');

    // A later render for the same account must not re-open the tour.
    rerender(renderer);
    expect(routerPush).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('never pushes once the account has finished or skipped the tour', async () => {
    state.isCompleted = true;
    const renderer = await mountAutoOpen();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('never pushes while signed out', async () => {
    state.userId = undefined;
    state.isLoaded = false;
    const renderer = await mountAutoOpen();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('never pushes before the stored decision has loaded', async () => {
    state.isLoaded = false;
    const renderer = await mountAutoOpen();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('does not push when the tour route is already active and never pushes later', async () => {
    state.pathname = '/(app)/tour';
    const renderer = await mountAutoOpen();

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
  it('holds the once-only marker through the consent gate and opens after it', async () => {
    consent.gate.result = { status: 'needs-consent', optional: false };
    state.pathname = '/consent';
    const renderer = await mountAutoOpen();

    expect(routerPush).not.toHaveBeenCalled();

    // Answering the gate lands on Home; the tour opens then, exactly once.
    state.pathname = '/(app)/(tabs)/(0_home)';
    await act(async () => {
      consent.emit({ userId: 'user-1', hasAccepted: true, optional: false });
      await Promise.resolve();
    });
    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/(app)/tour');

    rerender(renderer);
    expect(routerPush).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  // A consent read that fails is not "no gate": the bootstrap shows its own
  // retryable consent-error surface instead of the shell. Holding here mirrors
  // that, so the marker is never consumed against an unknown decision.
  it('keeps the marker when the consent read fails', async () => {
    consent.gate.result = { status: 'error', optional: false };
    const renderer = await mountAutoOpen();

    expect(routerPush).not.toHaveBeenCalled();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  // A cold start can mount the app shell at Home while the consent decision is
  // still loading. The bootstrap guard then replaces anything pushed there back
  // to the gate, so the hold must key off the consent STATE, not only off the
  // gate's pathname — otherwise the marker is consumed by a push that never
  // lands and the tour never auto-opens after the gate is answered.
  it('keeps the marker while consent is pending off the gate route and opens after it is answered', async () => {
    consent.gate.result = { status: 'needs-consent', optional: false };
    state.pathname = '/(app)/(tabs)/(0_home)';
    const renderer = await mountAutoOpen();

    expect(routerPush).not.toHaveBeenCalled();

    await act(async () => {
      consent.emit({ userId: 'user-1', hasAccepted: true, optional: false });
      await Promise.resolve();
    });
    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/(app)/tour');

    rerender(renderer);
    expect(routerPush).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});

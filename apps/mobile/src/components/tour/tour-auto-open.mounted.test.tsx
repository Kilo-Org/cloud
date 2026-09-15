import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TourAutoOpen } from './tour-auto-open';

const routerPush = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  userId: 'user-1' as string | undefined,
  isLoaded: true,
  isCompleted: false,
  pathname: '/(app)/(tabs)/(0_home)',
}));

// The account's consent-gate state, standing in for the SecureStore record the
// bootstrap gate reads. `accepted` by default: the pre-existing cases assume
// consent is already on file.
const consentGate = vi.hoisted(() => {
  type ConsentChange = { userId: string; hasAccepted: boolean; optional: boolean };
  type ConsentGateResult =
    | { status: 'accepted'; optional: boolean }
    | { status: 'needs-consent' }
    | { status: 'error'; error: unknown };
  const listeners = new Set<(change: ConsentChange) => void>();
  return {
    status: 'accepted' as 'accepted' | 'needs-consent' | 'error',
    check(): ConsentGateResult {
      if (this.status === 'error') {
        return { status: 'error', error: new Error('store') };
      }
      if (this.status === 'accepted') {
        return { status: 'accepted', optional: false };
      }
      return { status: 'needs-consent' };
    },
    notify(change: ConsentChange) {
      for (const listener of listeners) {
        listener(change);
      }
    },
    reset() {
      this.status = 'accepted';
      listeners.clear();
    },
    subscribe(listener: (change: ConsentChange) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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
  checkConsentGate: () => consentGate.check(),
}));

vi.mock('@/lib/consent', () => ({
  subscribeToConsentChanges: (listener: Parameters<typeof consentGate.subscribe>[0]) =>
    consentGate.subscribe(listener),
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

/** Flushes the consent-gate read (and any state update it lands). */
async function flushConsentRead() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TourAutoOpen', () => {
  beforeEach(() => {
    routerPush.mockReset();
    consentGate.reset();
    state.userId = 'user-1';
    state.isLoaded = true;
    state.isCompleted = false;
    state.pathname = '/(app)/(tabs)/(0_home)';
  });

  it('pushes the tour exactly once on a first sign-in that has not completed it', async () => {
    const renderer = mountAutoOpen();
    await flushConsentRead();

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/(app)/tour');

    // A later render for the same account must not re-open the tour.
    rerender(renderer);
    expect(routerPush).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('never pushes once the account has finished or skipped the tour', async () => {
    state.isCompleted = true;
    const renderer = mountAutoOpen();
    await flushConsentRead();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('never pushes while signed out', async () => {
    state.userId = undefined;
    state.isLoaded = false;
    const renderer = mountAutoOpen();
    await flushConsentRead();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('never pushes before the stored decision has loaded', async () => {
    state.isLoaded = false;
    const renderer = mountAutoOpen();
    await flushConsentRead();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('does not push when the tour route is already active and never pushes later', async () => {
    state.pathname = '/(app)/tour';
    const renderer = mountAutoOpen();
    await flushConsentRead();

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
    state.pathname = '/consent';
    const renderer = mountAutoOpen();
    await flushConsentRead();

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

  // A cold start with a stored token and unanswered consent mounts the (app)
  // tree on a normal route while the bootstrap wait runs; the gate redirect has
  // not landed yet. The marker must not be consumed there, or the gate bounces
  // the tour push and it never auto-opens after consent is answered.
  it('holds the marker through the consent wait on a non-consent route and opens once consent is answered', async () => {
    consentGate.status = 'needs-consent';
    state.pathname = '/(app)/(tabs)/(0_home)';
    const renderer = mountAutoOpen();
    await flushConsentRead();

    // Still unanswered: no push, and the marker is not consumed.
    expect(routerPush).not.toHaveBeenCalled();
    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    // The gate is answered: the change notification releases the hold and the
    // tour opens exactly once.
    consentGate.status = 'accepted';
    await flushConsentRead();
    consentGate.notify({ userId: 'user-1', hasAccepted: true, optional: false });
    await flushConsentRead();
    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/(app)/tour');

    rerender(renderer);
    expect(routerPush).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});

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

// The once-per-process cold-boot marker. Controllable so a case can start a
// launch already spent (a warm entry) or assert the attempt was consumed. The
// launch-account binding lives in the same module state, so it also survives a
// remount of the gate (a sign-out then a different sign-in).
const boot = vi.hoisted(() => ({ spent: false, attemptUserId: null as string | null }));

// The account's gateway-usage read. `isLoaded` true means the server answered;
// `hasUsage` is the account's answer once it did.
const usage = vi.hoisted(() => ({ isLoaded: true, hasUsage: false }));

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

vi.mock('@/lib/tour/tour-auto-open-boot', () => ({
  isTourAutoOpenAttemptSpent: () => boot.spent,
  spendTourAutoOpenAttempt: () => {
    boot.spent = true;
  },
  claimTourAutoOpenAttempt: (userId: string) => {
    if (boot.attemptUserId === null) {
      boot.attemptUserId = userId;
      return true;
    }
    return boot.attemptUserId === userId;
  },
}));

vi.mock('@/lib/tour/use-tour-gate-usage', () => ({
  useTourGatewayUsage: () => ({ isLoaded: usage.isLoaded, hasUsage: usage.hasUsage }),
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
    boot.spent = false;
    boot.attemptUserId = null;
    usage.isLoaded = true;
    usage.hasUsage = false;
    state.userId = 'user-1';
    state.isLoaded = true;
    state.isCompleted = false;
    state.pathname = '/(app)/(tabs)/(0_home)';
  });

  it('pushes the tour exactly once on a cold boot with zero gateway usage', async () => {
    const renderer = mountAutoOpen();
    await flushConsentRead();

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/(app)/tour');
    expect(boot.spent).toBe(true);

    // A later render for the same account must not re-open the tour.
    rerender(renderer);
    expect(routerPush).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('never pushes for an account with gateway usage, and spends the attempt', async () => {
    usage.hasUsage = true;
    const renderer = mountAutoOpen();
    await flushConsentRead();

    expect(routerPush).not.toHaveBeenCalled();
    // The launch attempt is consumed, so an account switch later in this
    // process cannot auto-open for a zero-usage account either.
    expect(boot.spent).toBe(true);

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('never pushes on a warm entry after the attempt is spent', async () => {
    boot.spent = true;
    const renderer = mountAutoOpen();
    await flushConsentRead();

    expect(routerPush).not.toHaveBeenCalled();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('holds on an unanswered usage read, then opens when the read succeeds in the same launch', async () => {
    usage.isLoaded = false;
    const renderer = mountAutoOpen();
    await flushConsentRead();

    // The read has not answered: hold, and do not spend the launch attempt.
    expect(routerPush).not.toHaveBeenCalled();
    expect(boot.spent).toBe(false);

    // The read succeeds with zero usage later in the same launch.
    usage.isLoaded = true;
    rerender(renderer);
    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/(app)/tour');
    expect(boot.spent).toBe(true);

    renderer.unmount();
  });

  // A warm account switch must not inherit the launch's unspent attempt: if the
  // launch account held (a completion or usage read never answered), a different
  // account signing in later in the same process must not auto-open the tour.
  it.each(['completion', 'usage'])(
    'never auto-opens after a warm switch during %s loading',
    async hold => {
      state.isLoaded = hold !== 'completion';
      usage.isLoaded = hold !== 'usage';
      const renderer = mountAutoOpen();
      await flushConsentRead();

      // The launch account holds on the unanswered read: no push, unspent.
      expect(routerPush).not.toHaveBeenCalled();
      expect(boot.spent).toBe(false);

      // A different account signs in later in the same process with zero usage.
      state.userId = 'user-2';
      state.isLoaded = true;
      usage.isLoaded = true;
      rerender(renderer);
      await flushConsentRead();

      // The launch attempt belongs to the first account, so the switch spends it
      // instead of opening the tour.
      expect(routerPush).not.toHaveBeenCalled();
      expect(boot.spent).toBe(true);

      rerender(renderer);
      expect(routerPush).not.toHaveBeenCalled();

      renderer.unmount();
    }
  );

  // The consent hold is the other hold that leaves the attempt unspent. The
  // launch account never answered the gate, so a different account signing in
  // later in the same process must not inherit the attempt either.
  it('does not auto-open for a warm account switch after a consent hold', async () => {
    consentGate.status = 'needs-consent';
    const renderer = mountAutoOpen();
    await flushConsentRead();

    // The launch account holds on the unanswered gate: no push, unspent.
    expect(routerPush).not.toHaveBeenCalled();
    expect(boot.spent).toBe(false);

    // A different account signs in later in the same process, with consent on
    // file and zero usage.
    state.userId = 'user-2';
    consentGate.status = 'accepted';
    rerender(renderer);
    await flushConsentRead();

    // The launch attempt belongs to the first account, so the switch spends it
    // instead of opening the tour.
    expect(routerPush).not.toHaveBeenCalled();
    expect(boot.spent).toBe(true);

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();

    renderer.unmount();
  });

  // Sign-out unmounts the `(app)` tree, including this gate, while the
  // process-wide attempt survives. A different account signing in remounts the
  // gate: the launch-account binding must survive that remount, or the second
  // account looks like the launch account and auto-opens the tour.
  it.each(['completion', 'usage'])(
    'never auto-opens after remounting during %s loading',
    async hold => {
      state.isLoaded = hold !== 'completion';
      usage.isLoaded = hold !== 'usage';
      const first = mountAutoOpen();
      await flushConsentRead();

      // The launch account held its unspent attempt; the (app) tree then unmounts
      // on the sign-out redirect.
      expect(routerPush).not.toHaveBeenCalled();
      expect(boot.spent).toBe(false);
      first.unmount();

      // A different account signs in and remounts the gate, with consent on file
      // and zero usage.
      state.userId = 'user-2';
      state.isLoaded = true;
      usage.isLoaded = true;
      const second = mountAutoOpen();
      await flushConsentRead();

      // The launch attempt belongs to the first account, so the remount spends it
      // instead of opening the tour.
      expect(routerPush).not.toHaveBeenCalled();
      expect(boot.spent).toBe(true);

      rerender(second);
      expect(routerPush).not.toHaveBeenCalled();

      second.unmount();
    }
  );

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
    expect(boot.attemptUserId).toBeNull();
    expect(boot.spent).toBe(false);

    renderer.unmount();
  });

  it('holds the launch account attempt until its stored decision has loaded', async () => {
    state.isLoaded = false;
    const renderer = mountAutoOpen();
    await flushConsentRead();

    rerender(renderer);
    expect(routerPush).not.toHaveBeenCalled();
    expect(boot.attemptUserId).toBe('user-1');
    expect(boot.spent).toBe(false);

    state.isLoaded = true;
    rerender(renderer);
    expect(routerPush).toHaveBeenCalledWith('/(app)/tour');
    expect(boot.spent).toBe(true);

    rerender(renderer);
    expect(routerPush).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('does not push when the tour route is already active and never re-arms the automatic open', async () => {
    // A manual replay (the Profile Tutorial row) put the tour on screen.
    state.pathname = '/(app)/tour';
    const renderer = mountAutoOpen();
    await flushConsentRead();

    expect(routerPush).not.toHaveBeenCalled();
    // The explicit open consumed the launch attempt.
    expect(boot.spent).toBe(true);

    // Navigating away must not push it behind them.
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

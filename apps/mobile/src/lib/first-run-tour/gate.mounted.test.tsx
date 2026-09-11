/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/test/render-with-providers.tsx. */
/* eslint-disable max-lines -- every scenario (cold, live sign-in, re-arrival, account switch, latch race) drives the same mounted gate and the same fake clock. */
import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FirstRunTourGate } from './gate';
import { renderWithProviders } from '@/test/render-with-providers';
import { type FirstRunTourDecision } from '@/lib/first-run-tour/tour-state';

const fixtures = vi.hoisted(() => ({
  token: 'token-1' as string | null,
  isSigningOut: false,
  userId: 'u1' as string | undefined,
  userIdLoading: false,
  segments: ['(app)', '(tabs)', '(0_home)'] as string[],
  // Accounts whose tour outcome this (simulated) process already recorded;
  // see hasRecordedFirstRunTourOutcome in tour-state.
  recordedOutcomes: new Set<string>(),
}));

const HOME = ['(app)', '(tabs)', '(0_home)'];
const TOUR = ['(app)', 'first-run-tour'];

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const loadDecisionMock = vi.hoisted(() =>
  vi.fn<(userId: string) => Promise<FirstRunTourDecision | null>>()
);

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  useSegments: () => fixtures.segments,
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: fixtures.token, isSigningOut: fixtures.isSigningOut }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: fixtures.userId, isLoading: fixtures.userIdLoading }),
}));
vi.mock('@/lib/first-run-tour/tour-state', () => ({
  loadFirstRunTourDecision: loadDecisionMock,
  hasRecordedFirstRunTourOutcome: (userId: string) => fixtures.recordedOutcomes.has(userId),
}));

/** Re-render the same tree so the hook fixtures are re-read by the gate. */
function renderGate(enabled: boolean) {
  return createElement(FirstRunTourGate, { enabled });
}

async function mountGate(enabled: boolean) {
  const mounted = await renderWithProviders(renderGate(enabled));
  // Flush microtasks so the first effect pass's async decision read settles
  // before the test starts driving the clock.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return {
    unmount: mounted.unmount,
    // Update the full tree: replacing only the gate would swap the root from
    // QueryClientProvider to the gate, remounting it and resetting the guard.
    rerender: (nextEnabled: boolean) => {
      act(() => {
        mounted.renderer.update(
          createElement(
            QueryClientProvider,
            { client: mounted.queryClient },
            renderGate(nextEnabled)
          )
        );
      });
    },
  };
}

/** Flush microtasks so the effect's async decision read settles. */
async function flushEffects(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/**
 * A decision read that never settles on its own: the test resolves it to
 * stand in for a slow SQLCipher read.
 */
function hangingDecisionRead() {
  let resolveDecision: (value: FirstRunTourDecision | null) => void = undefined as never;
  loadDecisionMock.mockReturnValue(
    new Promise<FirstRunTourDecision | null>(resolve => {
      resolveDecision = resolve;
    })
  );
  return () => {
    resolveDecision(null);
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fixtures.token = 'token-1';
  fixtures.isSigningOut = false;
  fixtures.userId = 'u1';
  fixtures.userIdLoading = false;
  fixtures.segments = HOME;
  fixtures.recordedOutcomes = new Set<string>();
  loadDecisionMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FirstRunTourGate', () => {
  it('pushes promptly once home is the settled route, and exactly once across re-renders', async () => {
    // No hold remains: the push lands on the decision read's resolution —
    // a 0 ms clock advance — not after any settle window.
    const { unmount, rerender } = await mountGate(true);
    expect(loadDecisionMock).toHaveBeenCalledWith('u1');
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledWith('/(app)/first-run-tour');

    // Re-renders of the same mount must not push again.
    rerender(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('pushes within a second of home becoming the route on the first post-sign-in arrival', async () => {
    // The process rendered the login screen before home. Earlier rounds held
    // the push out for a 15 s sign-in settle deadline keyed to the e2e login
    // helper's prompt-settling tail; the harness now observes first-sign-in
    // behavior through KILO_E2E_AFTER_LOGIN_FLOW before dismissing prompts,
    // so the gate pushes the moment home is settled and `enabled` releases
    // (owner, 2026-09-08).
    fixtures.segments = ['(auth)', 'login'];
    const { unmount, rerender } = await mountGate(false);
    fixtures.segments = HOME;
    rerender(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledWith('/(app)/first-run-tour');
    // A full second later: still exactly one push, proving nothing was
    // armed on a later deadline that could fire a second tour.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('cancels the push when the gate unmounts while the decision read is in flight', async () => {
    const resolveDecision = hangingDecisionRead();
    const { unmount } = await mountGate(true);
    await flushEffects();
    unmount();
    resolveDecision();
    await flushEffects();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('cancels the push when the route leaves home while the decision read is in flight', async () => {
    const resolveDecision = hangingDecisionRead();
    const { unmount, rerender } = await mountGate(true);
    await flushEffects();
    fixtures.segments = ['(app)', '(tabs)', '(2_agents)'];
    rerender(true);
    resolveDecision();
    await flushEffects();
    expect(routerMock.push).not.toHaveBeenCalled();
    unmount();
  });

  it('does not read or push while the route is not home', async () => {
    fixtures.segments = ['(app)', '(tabs)', '(2_agents)'];
    const { unmount, rerender } = await mountGate(true);
    await flushEffects();
    expect(loadDecisionMock).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
    // Arriving home later evaluates and pushes: the gate keys off the home
    // arrival itself, with no window measured from anything else.
    fixtures.segments = HOME;
    rerender(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('re-arms for the next home visit when the tour left no decision', async () => {
    // A programmatic removal (deep-link RESET — see the back guard) dismisses
    // the tour without recording a decision. The next home arrival must
    // re-open it, or the person never gets the tour they never finished.
    const { unmount, rerender } = await mountGate(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);

    // The push lands: the route is the tour, which releases the visit latch.
    fixtures.segments = TOUR;
    rerender(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);

    // Removed without a decision (mock keeps answering null): back on home,
    // the gate re-arms and pushes again.
    fixtures.segments = HOME;
    rerender(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not re-arm when the dismissed tour recorded a decision', async () => {
    const { unmount, rerender } = await mountGate(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);

    // Skip/Finish/back record the decision, then land back on home.
    fixtures.segments = TOUR;
    rerender(true);
    loadDecisionMock.mockResolvedValue({ status: 'skipped' });
    fixtures.segments = HOME;
    rerender(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('never pushes again in this process for an account whose outcome was recorded', async () => {
    // The mark ran for this account earlier in this process (Skip/Finish/
    // hardware back) but the persisted read still answers null — the write is
    // in flight, or it failed and reads as the eligible default. The latch is
    // the authority: the tour the person just dismissed must not re-open.
    fixtures.recordedOutcomes.add('u1');
    const { unmount, rerender } = await mountGate(true);
    await flushEffects();
    expect(routerMock.push).not.toHaveBeenCalled();
    // Not even a later re-render re-arms it: the latch is process-lifetime.
    rerender(true);
    await flushEffects();
    expect(routerMock.push).not.toHaveBeenCalled();
    unmount();
  });

  it('does not re-open a tour dismissed mid-process while the decision read races the write', async () => {
    // Live sequence (2026-09-07): the tour pushed, hardware back dismissed
    // it, home re-arrived, and the gate's re-read raced the in-flight skip —
    // the tour re-opened 10 s after the person left it.
    const { unmount, rerender } = await mountGate(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);

    // The dismissal lands (no stored decision yet — the write is in flight)
    // and latches the outcome for this process.
    fixtures.segments = TOUR;
    rerender(true);
    fixtures.recordedOutcomes.add('u1');
    loadDecisionMock.mockResolvedValue(null);
    fixtures.segments = HOME;
    rerender(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('never pushes while the decision read is still in flight', async () => {
    const resolveDecision = hangingDecisionRead();
    const { unmount } = await mountGate(true);
    // No decision yet, so the push must wait for the read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(routerMock.push).not.toHaveBeenCalled();
    // The decision arriving releases the push; the clock already ran, so a
    // slow read must not also pay any hold.
    resolveDecision();
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    unmount();
  });

  for (const status of ['done', 'skipped'] as const) {
    it(`never pushes when a '${status}' decision already exists`, async () => {
      loadDecisionMock.mockResolvedValue({ status });
      const { unmount } = await mountGate(true);
      await flushEffects();
      expect(routerMock.push).not.toHaveBeenCalled();
      unmount();
    });
  }

  it('never pushes or reads the decision while disabled', async () => {
    const { unmount, rerender } = await mountGate(false);
    expect(loadDecisionMock).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
    // Enabling later evaluates and pushes: the disabled branch was a gate,
    // not a permanent veto.
    rerender(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('never pushes while signing out', async () => {
    fixtures.isSigningOut = true;
    const { unmount } = await mountGate(true);
    await flushEffects();
    expect(loadDecisionMock).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
    unmount();
  });

  it('pushes once per account: an account switch within the same mount pushes for the new account', async () => {
    const { unmount, rerender } = await mountGate(true);
    await flushEffects();
    expect(loadDecisionMock).toHaveBeenCalledWith('u1');
    expect(routerMock.push).toHaveBeenCalledTimes(1);

    // Account switch within the same mount: RootLayoutNav never remounts on
    // sign-out → sign-in, so the route passes through the auth group (which
    // releases the visit latch) and the new account's decision is read and
    // its tour pushed. The old account's un-fired read is cancelled by the
    // re-render, never pushed.
    fixtures.token = null;
    fixtures.userId = undefined;
    fixtures.segments = ['(auth)', 'login'];
    rerender(true);
    await flushEffects();
    fixtures.token = 'token-2';
    fixtures.userId = 'u2';
    fixtures.segments = HOME;
    rerender(true);
    await flushEffects();
    expect(loadDecisionMock).toHaveBeenCalledWith('u2');
    expect(routerMock.push).toHaveBeenCalledTimes(2);

    // Re-renders after both accounts pushed must not push a third time.
    rerender(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('re-arms on sign-out so a re-sign-in without a decision pushes again', async () => {
    const { unmount, rerender } = await mountGate(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);

    // Sign out: the token clears, which releases the guard, and nothing is
    // read or pushed while signed out.
    fixtures.token = null;
    fixtures.userId = undefined;
    rerender(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(1);

    // Sign back into the same account: still no decision, so the tour opens
    // again — the gate re-arms for the fresh session.
    fixtures.token = 'token-2';
    fixtures.userId = 'u1';
    rerender(true);
    await flushEffects();
    expect(routerMock.push).toHaveBeenCalledTimes(2);
    expect(loadDecisionMock).toHaveBeenCalledTimes(2);
    expect(loadDecisionMock).toHaveBeenLastCalledWith('u1');
    unmount();
  });
});

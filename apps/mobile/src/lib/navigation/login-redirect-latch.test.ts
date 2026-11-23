import { describe, expect, it } from 'vitest';

import { createLoginRedirectLatch, loginRedirectDecision } from './login-redirect-latch';

const login = (navigationReady = true) => ({ decision: 'login' as const, navigationReady });
const wait = { decision: 'wait' as const, navigationReady: true };
const settleLogin = { decision: 'other' as const, navigationReady: true };

describe('loginRedirectDecision', () => {
  it('classifies the login redirect alone as the login decision', () => {
    expect(loginRedirectDecision('redirect-login')).toBe('login');
  });

  it('classifies both waits as waits', () => {
    // These are the renders that sit between the repeated sign-out decisions.
    expect(loginRedirectDecision('wait-loading')).toBe('wait');
    expect(loginRedirectDecision('wait-user-consent')).toBe('wait');
  });

  it('classifies the settled login counterpart as a departure', () => {
    expect(loginRedirectDecision('settle-login')).toBe('other');
  });

  it('classifies the other redirects and errors as departures', () => {
    expect(loginRedirectDecision('redirect-consent')).toBe('other');
    expect(loginRedirectDecision('redirect-app')).toBe('other');
    expect(loginRedirectDecision('settle-user-error')).toBe('other');
  });
});

describe('createLoginRedirectLatch', () => {
  it('admits the first login decision and refuses every repeat', () => {
    // The reported defect: the token is cleared, and each render before the
    // segments update re-emits `redirect-login`. Only the first may replace.
    const latch = createLoginRedirectLatch();

    expect(latch.shouldDispatch(login())).toBe(true);
    expect(latch.shouldDispatch(login())).toBe(false);
    expect(latch.shouldDispatch(login())).toBe(false);
  });

  it('does not consume the dispatch while the navigator is not ready', () => {
    // A dispatch skipped for readiness must not latch: the effect reruns when
    // readiness flips, and that rerun is the one that replaces.
    const latch = createLoginRedirectLatch();

    expect(latch.shouldDispatch(login(false))).toBe(false);
    expect(latch.shouldDispatch(login())).toBe(true);
    expect(latch.shouldDispatch(login())).toBe(false);
  });

  it('keeps the latch across the waits between the repeat decisions', () => {
    // Releasing on a wait would let the following `redirect-login` replace
    // login a second time.
    const latch = createLoginRedirectLatch();

    expect(latch.shouldDispatch(login())).toBe(true);
    expect(latch.shouldDispatch(wait)).toBe(false);
    expect(latch.shouldDispatch(login())).toBe(false);
  });

  it('releases on the settle that follows the login route mounting', () => {
    // Without this release the next sign-out would never reach login, so a
    // failing assertion here is the same defect as a latch never cleared.
    const latch = createLoginRedirectLatch();

    expect(latch.shouldDispatch(login())).toBe(true);
    expect(latch.shouldDispatch(settleLogin)).toBe(false);
    expect(latch.shouldDispatch(login())).toBe(true);
  });

  it('releases on a departure that arrives while the navigator is not ready', () => {
    const latch = createLoginRedirectLatch();

    expect(latch.shouldDispatch(login())).toBe(true);
    expect(latch.shouldDispatch({ decision: 'other', navigationReady: false })).toBe(false);
    expect(latch.shouldDispatch(login())).toBe(true);
  });

  it('never dispatches for another destination', () => {
    const latch = createLoginRedirectLatch();

    expect(latch.shouldDispatch({ decision: 'other', navigationReady: true })).toBe(false);
    expect(latch.shouldDispatch(login())).toBe(true);
  });
});

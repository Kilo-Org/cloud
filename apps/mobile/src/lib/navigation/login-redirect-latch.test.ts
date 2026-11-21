import { describe, expect, it } from 'vitest';

import { LOGIN_REDIRECT_RETRY_MS, shouldDispatchLoginRedirect } from './login-redirect-latch';

const t0 = 1_000_000;

describe('shouldDispatchLoginRedirect', () => {
  it('dispatches login when nothing is latched', () => {
    expect(shouldDispatchLoginRedirect(null, t0)).toBe(true);
  });

  it('skips every repeat of the decision already dispatched', () => {
    // The window this covers: the token is cleared and the decision re-emits
    // `redirect-login` on each render until the segments report (auth).
    const latch = { dispatchedAt: t0 };
    expect(shouldDispatchLoginRedirect(latch, t0)).toBe(false);
    expect(shouldDispatchLoginRedirect(latch, t0 + 16)).toBe(false);
    expect(shouldDispatchLoginRedirect(latch, t0 + LOGIN_REDIRECT_RETRY_MS - 1)).toBe(false);
  });

  it('re-arms when the decision settled, so the next sign-out dispatches login', () => {
    // The caller clears the latch on settle; a later sign-out reaches login
    // again even a moment after the previous one.
    expect(shouldDispatchLoginRedirect(null, t0 + 5)).toBe(true);
  });

  it('retries a replace that never landed', () => {
    const latch = { dispatchedAt: t0 };
    expect(shouldDispatchLoginRedirect(latch, t0 + LOGIN_REDIRECT_RETRY_MS)).toBe(true);
  });
});

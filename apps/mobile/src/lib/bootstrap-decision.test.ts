import { describe, expect, it } from 'vitest';

import { resolveBootstrapDecision } from './bootstrap-decision';

// The settled, signed-in, consent-granted, app-ready state: every guard passes
// and the decision falls through to `settle-app`.
const ready = {
  isLoading: false,
  updateRequired: false,
  inForceUpdate: false,
  inAuthGroup: false,
  hasToken: true,
  userIdLoading: false,
  userIdError: false,
  consentCheckError: false,
  consentChecked: true,
  needsConsent: false,
  onConsentRoute: false,
  onConsentReviewRoute: false,
  languageReloadFailed: false,
  restoreFailed: false,
} as const;

describe('resolveBootstrapDecision tag', () => {
  it('waits while loading', () => {
    expect(resolveBootstrapDecision({ ...ready, isLoading: true }).tag).toBe('wait-loading');
  });

  it('redirects to force-update when an update is required off the route', () => {
    expect(resolveBootstrapDecision({ ...ready, updateRequired: true }).tag).toBe(
      'redirect-force-update'
    );
  });

  it('settles force-update when an update is required on the route', () => {
    expect(
      resolveBootstrapDecision({ ...ready, updateRequired: true, inForceUpdate: true }).tag
    ).toBe('settle-force-update');
  });

  it('exits force-update when the route is stale', () => {
    expect(resolveBootstrapDecision({ ...ready, inForceUpdate: true }).tag).toBe(
      'exit-force-update'
    );
  });

  it('settles login without a token in the auth group', () => {
    expect(resolveBootstrapDecision({ ...ready, hasToken: false, inAuthGroup: true }).tag).toBe(
      'settle-login'
    );
  });

  it('redirects to login without a token outside the auth group', () => {
    expect(resolveBootstrapDecision({ ...ready, hasToken: false }).tag).toBe('redirect-login');
  });

  it('settles the user error when the user id failed', () => {
    expect(resolveBootstrapDecision({ ...ready, userIdError: true }).tag).toBe('settle-user-error');
  });

  it('settles the consent error when the consent check failed', () => {
    expect(resolveBootstrapDecision({ ...ready, consentCheckError: true }).tag).toBe(
      'settle-consent-error'
    );
  });

  it('waits while the user id is loading', () => {
    expect(resolveBootstrapDecision({ ...ready, userIdLoading: true }).tag).toBe(
      'wait-user-consent'
    );
  });

  it('waits before consent is checked', () => {
    expect(resolveBootstrapDecision({ ...ready, consentChecked: false }).tag).toBe(
      'wait-user-consent'
    );
  });

  it('settles consent when needed on the consent route', () => {
    expect(
      resolveBootstrapDecision({ ...ready, needsConsent: true, onConsentRoute: true }).tag
    ).toBe('settle-consent');
  });

  it('redirects to consent when needed off the consent route', () => {
    expect(resolveBootstrapDecision({ ...ready, needsConsent: true }).tag).toBe('redirect-consent');
  });

  it('redirects to the app on a non-review consent route', () => {
    expect(
      resolveBootstrapDecision({ ...ready, onConsentRoute: true, onConsentReviewRoute: false }).tag
    ).toBe('redirect-app');
  });

  it('redirects to the app in the auth group', () => {
    expect(resolveBootstrapDecision({ ...ready, inAuthGroup: true }).tag).toBe('redirect-app');
  });

  it('settles the app on the success tail', () => {
    expect(resolveBootstrapDecision(ready).tag).toBe('settle-app');
  });

  it('settles the restore error when the startup credential read failed', () => {
    expect(resolveBootstrapDecision({ ...ready, restoreFailed: true }).tag).toBe(
      'settle-restore-error'
    );
  });

  it('suppresses redirect-login while the restore error is up', () => {
    // The failed read leaves no token, but the session is not known to be
    // gone: routing to login would be the silent sign-out this branch exists
    // to prevent.
    expect(resolveBootstrapDecision({ ...ready, restoreFailed: true, hasToken: false }).tag).toBe(
      'settle-restore-error'
    );
    expect(
      resolveBootstrapDecision({
        ...ready,
        restoreFailed: true,
        hasToken: false,
        inAuthGroup: true,
      }).tag
    ).toBe('settle-restore-error');
  });

  it('keeps the force-update branches ahead of the restore error', () => {
    expect(
      resolveBootstrapDecision({ ...ready, restoreFailed: true, updateRequired: true }).tag
    ).toBe('redirect-force-update');
    expect(
      resolveBootstrapDecision({
        ...ready,
        restoreFailed: true,
        updateRequired: true,
        inForceUpdate: true,
      }).tag
    ).toBe('settle-force-update');
  });

  it('waits while loading rather than settling the restore error', () => {
    // Retry sets `isLoading` back to true, so the error surface is replaced by
    // the startup gate instead of flickering back to itself.
    expect(resolveBootstrapDecision({ ...ready, restoreFailed: true, isLoading: true }).tag).toBe(
      'wait-loading'
    );
  });

  it('settles the language error first, before loading, when the RTL reload failed', () => {
    expect(
      resolveBootstrapDecision({ ...ready, languageReloadFailed: true, isLoading: true }).tag
    ).toBe('settle-language-error');
  });

  it('settles the language error for a signed-out cold start', () => {
    expect(
      resolveBootstrapDecision({ ...ready, hasToken: false, languageReloadFailed: true }).tag
    ).toBe('settle-language-error');
  });

  it('settles the language error for a signed-in cold start', () => {
    expect(resolveBootstrapDecision({ ...ready, languageReloadFailed: true }).tag).toBe(
      'settle-language-error'
    );
  });
});

describe('resolveBootstrapDecision derivations', () => {
  it('derives hasUserBootstrapError from token and user error', () => {
    expect(resolveBootstrapDecision(ready).hasUserBootstrapError).toBe(false);
    expect(resolveBootstrapDecision({ ...ready, userIdError: true }).hasUserBootstrapError).toBe(
      true
    );
    expect(
      resolveBootstrapDecision({ ...ready, userIdError: true, hasToken: false })
        .hasUserBootstrapError
    ).toBe(false);
  });

  it('derives hasConsentBootstrapError from token and consent error', () => {
    expect(resolveBootstrapDecision(ready).hasConsentBootstrapError).toBe(false);
    expect(
      resolveBootstrapDecision({ ...ready, consentCheckError: true }).hasConsentBootstrapError
    ).toBe(true);
    expect(
      resolveBootstrapDecision({ ...ready, consentCheckError: true, hasToken: false })
        .hasConsentBootstrapError
    ).toBe(false);
  });

  it('derives hasBootstrapError as the union of both error flags', () => {
    expect(resolveBootstrapDecision(ready).hasBootstrapError).toBe(false);
    expect(resolveBootstrapDecision({ ...ready, userIdError: true }).hasBootstrapError).toBe(true);
    expect(resolveBootstrapDecision({ ...ready, consentCheckError: true }).hasBootstrapError).toBe(
      true
    );
  });

  it('derives hasLanguageReloadError only from languageReloadFailed', () => {
    expect(resolveBootstrapDecision(ready).hasLanguageReloadError).toBe(false);
    expect(
      resolveBootstrapDecision({ ...ready, languageReloadFailed: true }).hasLanguageReloadError
    ).toBe(true);
    expect(
      resolveBootstrapDecision({ ...ready, hasToken: false, languageReloadFailed: true })
        .hasLanguageReloadError
    ).toBe(true);
  });

  it('includes the language reload error in hasBootstrapError', () => {
    expect(
      resolveBootstrapDecision({ ...ready, languageReloadFailed: true }).hasBootstrapError
    ).toBe(true);
  });

  it('derives hasRestoreError only from restoreFailed', () => {
    expect(resolveBootstrapDecision(ready).hasRestoreError).toBe(false);
    expect(resolveBootstrapDecision({ ...ready, restoreFailed: true }).hasRestoreError).toBe(true);
    expect(
      resolveBootstrapDecision({ ...ready, hasToken: false, restoreFailed: true }).hasRestoreError
    ).toBe(true);
    // The surface stays up while a retry is loading: `hasRestoreError` is
    // independent of `isLoading`, so the settled error screen is never hidden
    // behind the loading gate mid-retry (the tag already waits, above).
    expect(
      resolveBootstrapDecision({ ...ready, restoreFailed: true, isLoading: true }).hasRestoreError
    ).toBe(true);
  });

  it('includes the restore error in hasBootstrapError', () => {
    expect(resolveBootstrapDecision({ ...ready, restoreFailed: true }).hasBootstrapError).toBe(
      true
    );
  });

  it('derives hidden from loading, redirect, or consent loading, unless a bootstrap error shows', () => {
    expect(resolveBootstrapDecision(ready).hidden).toBe(false);
    expect(resolveBootstrapDecision({ ...ready, isLoading: true }).hidden).toBe(true);
    expect(resolveBootstrapDecision({ ...ready, needsConsent: true }).hidden).toBe(true);
    expect(resolveBootstrapDecision({ ...ready, consentChecked: false }).hidden).toBe(true);
    expect(resolveBootstrapDecision({ ...ready, userIdError: true }).hidden).toBe(false);
    expect(resolveBootstrapDecision({ ...ready, consentCheckError: true }).hidden).toBe(false);
    expect(resolveBootstrapDecision({ ...ready, languageReloadFailed: true }).hidden).toBe(false);
    expect(
      resolveBootstrapDecision({ ...ready, languageReloadFailed: true, isLoading: true }).hidden
    ).toBe(false);
    // The restore error is a settled surface: the tree stays visible instead
    // of hiding behind the redirect that the missing token would imply.
    expect(
      resolveBootstrapDecision({ ...ready, restoreFailed: true, hasToken: false }).hidden
    ).toBe(false);
  });
});

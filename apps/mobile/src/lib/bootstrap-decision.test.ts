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

  it('derives consentLoading only while consent is pending outside gated routes', () => {
    expect(resolveBootstrapDecision({ ...ready, consentChecked: false }).consentLoading).toBe(true);
    expect(
      resolveBootstrapDecision({ ...ready, consentChecked: false, hasToken: false }).consentLoading
    ).toBe(false);
    expect(
      resolveBootstrapDecision({ ...ready, consentChecked: false, inAuthGroup: true })
        .consentLoading
    ).toBe(false);
    expect(
      resolveBootstrapDecision({ ...ready, consentChecked: false, inForceUpdate: true })
        .consentLoading
    ).toBe(false);
    expect(
      resolveBootstrapDecision({ ...ready, consentChecked: false, onConsentRoute: true })
        .consentLoading
    ).toBe(false);
  });

  it('derives needsForceUpdate from updateRequired off the force-update route', () => {
    expect(resolveBootstrapDecision({ ...ready, updateRequired: true }).needsForceUpdate).toBe(
      true
    );
    expect(
      resolveBootstrapDecision({ ...ready, updateRequired: true, inForceUpdate: true })
        .needsForceUpdate
    ).toBe(false);
  });

  it('derives showingForceUpdate from updateRequired on the force-update route', () => {
    expect(
      resolveBootstrapDecision({ ...ready, updateRequired: true, inForceUpdate: true })
        .showingForceUpdate
    ).toBe(true);
    expect(resolveBootstrapDecision({ ...ready, updateRequired: true }).showingForceUpdate).toBe(
      false
    );
  });

  it('derives needsAuth from a missing token outside the auth group', () => {
    expect(resolveBootstrapDecision({ ...ready, hasToken: false }).needsAuth).toBe(true);
    expect(
      resolveBootstrapDecision({ ...ready, hasToken: false, inAuthGroup: true }).needsAuth
    ).toBe(false);
  });

  it('derives needsAppRedirect from a token in the auth group', () => {
    expect(resolveBootstrapDecision({ ...ready, inAuthGroup: true }).needsAppRedirect).toBe(true);
    expect(resolveBootstrapDecision(ready).needsAppRedirect).toBe(false);
  });

  it('derives needsConsentRedirect from checked consent still needed off the route', () => {
    expect(resolveBootstrapDecision({ ...ready, needsConsent: true }).needsConsentRedirect).toBe(
      true
    );
    expect(
      resolveBootstrapDecision({ ...ready, needsConsent: true, onConsentRoute: true })
        .needsConsentRedirect
    ).toBe(false);
    expect(
      resolveBootstrapDecision({ ...ready, needsConsent: true, consentChecked: false })
        .needsConsentRedirect
    ).toBe(false);
  });

  it('derives needsRedirect from any redirect branch, suppressed by loading or showing force-update', () => {
    expect(resolveBootstrapDecision(ready).needsRedirect).toBe(false);
    expect(resolveBootstrapDecision({ ...ready, isLoading: true }).needsRedirect).toBe(false);
    expect(resolveBootstrapDecision({ ...ready, updateRequired: true }).needsRedirect).toBe(true);
    expect(resolveBootstrapDecision({ ...ready, hasToken: false }).needsRedirect).toBe(true);
    expect(resolveBootstrapDecision({ ...ready, inAuthGroup: true }).needsRedirect).toBe(true);
    expect(resolveBootstrapDecision({ ...ready, needsConsent: true }).needsRedirect).toBe(true);
    expect(
      resolveBootstrapDecision({ ...ready, updateRequired: true, inForceUpdate: true })
        .needsRedirect
    ).toBe(false);
  });

  it('derives hidden from loading, redirect, or consent loading, unless a bootstrap error shows', () => {
    expect(resolveBootstrapDecision(ready).hidden).toBe(false);
    expect(resolveBootstrapDecision({ ...ready, isLoading: true }).hidden).toBe(true);
    expect(resolveBootstrapDecision({ ...ready, needsConsent: true }).hidden).toBe(true);
    expect(resolveBootstrapDecision({ ...ready, consentChecked: false }).hidden).toBe(true);
    expect(resolveBootstrapDecision({ ...ready, userIdError: true }).hidden).toBe(false);
    expect(resolveBootstrapDecision({ ...ready, consentCheckError: true }).hidden).toBe(false);
  });
});

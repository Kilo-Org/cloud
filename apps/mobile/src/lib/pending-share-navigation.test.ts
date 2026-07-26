import { describe, expect, it } from 'vitest';

import { isShellReadyForShare, resolvePendingShareNavigation } from './pending-share-navigation';

const ready = {
  hasToken: true,
  isLoading: false,
  updateRequired: false,
  inAuthGroup: false,
  inForceUpdate: false,
  userIdLoading: false,
  userIdError: false,
  consentCheckError: false,
  consentChecked: true,
  needsConsent: false,
  onConsentRoute: false,
  onConsentReviewRoute: false,
} as const;

describe('isShellReadyForShare', () => {
  it('is true when every guard is satisfied', () => {
    expect(isShellReadyForShare(ready)).toBe(true);
  });

  it('is false while loading', () => {
    expect(isShellReadyForShare({ ...ready, isLoading: true })).toBe(false);
  });

  it('is false when an update is required', () => {
    expect(isShellReadyForShare({ ...ready, updateRequired: true })).toBe(false);
  });

  it('is false on the force-update route', () => {
    expect(isShellReadyForShare({ ...ready, inForceUpdate: true })).toBe(false);
  });

  it('is false without a token', () => {
    expect(isShellReadyForShare({ ...ready, hasToken: false })).toBe(false);
  });

  it('is false when user id failed', () => {
    expect(isShellReadyForShare({ ...ready, userIdError: true })).toBe(false);
  });

  it('is false when consent check failed', () => {
    expect(isShellReadyForShare({ ...ready, consentCheckError: true })).toBe(false);
  });

  it('is false while user id is loading', () => {
    expect(isShellReadyForShare({ ...ready, userIdLoading: true })).toBe(false);
  });

  it('is false before consent is checked', () => {
    expect(isShellReadyForShare({ ...ready, consentChecked: false })).toBe(false);
  });

  it('is false when consent is still needed', () => {
    expect(isShellReadyForShare({ ...ready, needsConsent: true })).toBe(false);
  });

  it('is false in the auth group', () => {
    expect(isShellReadyForShare({ ...ready, inAuthGroup: true })).toBe(false);
  });

  it('is false on a non-review consent route', () => {
    expect(
      isShellReadyForShare({
        ...ready,
        onConsentRoute: true,
        onConsentReviewRoute: false,
      })
    ).toBe(false);
  });

  it('is true on the consent review route when other guards pass', () => {
    expect(
      isShellReadyForShare({
        ...ready,
        onConsentRoute: true,
        onConsentReviewRoute: true,
      })
    ).toBe(true);
  });
});

describe('resolvePendingShareNavigation', () => {
  it('returns null without a share id', () => {
    expect(resolvePendingShareNavigation({ shareId: null, onGateRoute: false })).toBeNull();
  });

  it('pushes the gate when not already on it', () => {
    expect(resolvePendingShareNavigation({ shareId: 'abc', onGateRoute: false })).toEqual({
      href: '/(app)/share-gate?shareId=abc',
      mode: 'push',
    });
  });

  it('replaces when already on the gate route', () => {
    expect(resolvePendingShareNavigation({ shareId: 'abc', onGateRoute: true })).toEqual({
      href: '/(app)/share-gate?shareId=abc',
      mode: 'replace',
    });
  });

  it('includes the share id in the href', () => {
    const result = resolvePendingShareNavigation({ shareId: 'share-42', onGateRoute: false });
    expect(result?.href).toContain('shareId=share-42');
  });
});

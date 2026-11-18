import { describe, expect, it } from 'vitest';

import {
  isShellReadyForShare,
  resolvePendingShareNavigation,
  resolveSupersededPendingShareId,
  SHARE_INTENT_OPTIONS,
  shouldIngestShareIntent,
} from './pending-share-navigation';

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

describe('resolveSupersededPendingShareId', () => {
  // 2×2: current null|set × next same|different
  it('returns null when the slot is empty', () => {
    expect(resolveSupersededPendingShareId(null, 'next')).toBeNull();
  });

  it('returns null when current equals next', () => {
    expect(resolveSupersededPendingShareId('same', 'same')).toBeNull();
  });

  it('returns current when it differs from next', () => {
    expect(resolveSupersededPendingShareId('old', 'new')).toBe('old');
  });

  it('returns the prior id for any distinct pair', () => {
    expect(resolveSupersededPendingShareId('a', 'b')).toBe('a');
    expect(resolveSupersededPendingShareId('b', 'a')).toBe('b');
  });
});

describe('shouldIngestShareIntent', () => {
  it('is true only when a share intent exists and the shell is ready', () => {
    expect(shouldIngestShareIntent({ hasShareIntent: true, isShellReady: true })).toBe(true);
    expect(shouldIngestShareIntent({ hasShareIntent: true, isShellReady: false })).toBe(false);
    expect(shouldIngestShareIntent({ hasShareIntent: false, isShellReady: true })).toBe(false);
    expect(shouldIngestShareIntent({ hasShareIntent: false, isShellReady: false })).toBe(false);
  });

  it('stays in lockstep with isShellReadyForShare', () => {
    // The ingest copies temp files that only the share gate consumes. If it ran
    // on a guard the gate does not share, the sign-in reap would delete them.
    for (const key of Object.keys(ready) as (keyof typeof ready)[]) {
      const isShellReady = isShellReadyForShare({ ...ready, [key]: !ready[key] });
      expect(shouldIngestShareIntent({ hasShareIntent: true, isShellReady })).toBe(isShellReady);
    }
  });
});

describe('SHARE_INTENT_OPTIONS', () => {
  it('keeps the share intent across a backgrounding', () => {
    // A signed-out share becomes ingestable only after a sign-in that leaves
    // the app. The provider default (resetOnBackground: true) would clear the
    // payload first and the deferred ingest would never run.
    expect(SHARE_INTENT_OPTIONS.resetOnBackground).toBe(false);
  });
});

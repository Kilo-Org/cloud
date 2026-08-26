import { type ShareIntentProvider } from 'expo-share-intent';
import { type ComponentProps } from 'react';

import { type ShareId } from '@/lib/share-payload';

/** The provider does not re-export its own options type. */
type ShareIntentOptions = NonNullable<ComponentProps<typeof ShareIntentProvider>['options']>;

/**
 * Options for the app's single `ShareIntentProvider`.
 *
 * `resetOnBackground` defaults to `true`, which clears the native payload and
 * the JS state whenever the app leaves the foreground. The share ingest waits
 * for `isShellReadyForShare`, and a signed-out share reaches that state only
 * after a sign-in that leaves the app (OAuth browser, Apple/Google sheet), so
 * the default would drop the payload before the ingest ever runs. The ingest
 * resets the intent itself once it has copied the files.
 */
export const SHARE_INTENT_OPTIONS: ShareIntentOptions = { resetOnBackground: false };

/**
 * Guard for the share ingest effect in `_layout.tsx`. Copying the shared files
 * while signed out registers temp files that the sign-in reap in
 * `clearSessionScopedState` deletes before the gate ever reads them, so the
 * copy waits for the same `isShellReadyForShare` result the gate effect uses.
 */
export function shouldIngestShareIntent(input: {
  hasShareIntent: boolean;
  isShellReady: boolean;
}): boolean {
  return input.hasShareIntent && input.isShellReady;
}

/**
 * Conjunction of the guards the auth effect in `_layout.tsx` passes before its
 * success tail. Consumed by BOTH the pending-share gate effect and the pending
 * deep-link consumer. Keep in lockstep with that effect — do not refactor either
 * in isolation.
 */
export function isShellReadyForShare(input: {
  hasToken: boolean;
  isLoading: boolean;
  updateRequired: boolean;
  inAuthGroup: boolean;
  inForceUpdate: boolean;
  userIdLoading: boolean;
  userIdError: boolean;
  consentCheckError: boolean;
  consentChecked: boolean;
  needsConsent: boolean;
  onConsentRoute: boolean;
  onConsentReviewRoute: boolean;
}): boolean {
  return (
    !input.isLoading &&
    !input.updateRequired &&
    !input.inForceUpdate &&
    input.hasToken &&
    !input.userIdError &&
    !input.consentCheckError &&
    !input.userIdLoading &&
    input.consentChecked &&
    !input.needsConsent &&
    !input.inAuthGroup &&
    !(input.onConsentRoute && !input.onConsentReviewRoute)
  );
}

export function resolvePendingShareNavigation(input: {
  shareId: ShareId | null;
  onGateRoute: boolean;
}): { href: string; mode: 'push' | 'replace' } | null {
  if (input.shareId === null) {
    return null;
  }
  return {
    href: `/(app)/share-gate?shareId=${encodeURIComponent(input.shareId)}`,
    mode: input.onGateRoute ? 'replace' : 'push',
  };
}

/**
 * Latest-wins pending slot: when a newer share id replaces a different
 * pending id, return the superseded id so callers can release its payload
 * and cache copies. Same id or empty slot → null (nothing to release).
 */
export function resolveSupersededPendingShareId(
  current: ShareId | null,
  next: ShareId
): ShareId | null {
  if (current !== null && current !== next) {
    return current;
  }
  return null;
}

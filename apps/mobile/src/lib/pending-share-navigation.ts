import { type ShareId } from '@/lib/share-payload';

/**
 * Conjunction of the guards the auth effect in `_layout.tsx` passes before its
 * success tail. Keep in lockstep with that effect — do not refactor either in isolation.
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

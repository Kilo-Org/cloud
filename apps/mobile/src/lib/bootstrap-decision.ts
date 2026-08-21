/**
 * Pure bootstrap routing decision, extracted from the inline if-chain in
 * `_layout.tsx`'s auth effect. Consumed by BOTH the routing effect and the
 * render gating derivations. Keep in lockstep with that effect — do not
 * refactor either in isolation.
 */

type BootstrapDecisionTag =
  | 'wait-loading'
  | 'redirect-force-update'
  | 'settle-force-update'
  | 'exit-force-update'
  | 'settle-login'
  | 'redirect-login'
  | 'settle-user-error'
  | 'settle-consent-error'
  | 'wait-user-consent'
  | 'settle-consent'
  | 'redirect-consent'
  | 'redirect-app'
  | 'settle-app';

export type BootstrapDecisionInput = {
  isLoading: boolean;
  updateRequired: boolean;
  inForceUpdate: boolean;
  inAuthGroup: boolean;
  hasToken: boolean;
  userIdLoading: boolean;
  userIdError: boolean;
  consentCheckError: boolean;
  consentChecked: boolean;
  needsConsent: boolean;
  onConsentRoute: boolean;
  onConsentReviewRoute: boolean;
};

export type BootstrapDecision = {
  tag: BootstrapDecisionTag;
  hasUserBootstrapError: boolean;
  hasConsentBootstrapError: boolean;
  hasBootstrapError: boolean;
  hidden: boolean;
};

// Order mirrors the auth effect's if-chain exactly: earlier branches win.
function resolveBootstrapTag(input: BootstrapDecisionInput): BootstrapDecisionTag {
  if (input.isLoading) {
    return 'wait-loading';
  }
  if (input.updateRequired) {
    return input.inForceUpdate ? 'settle-force-update' : 'redirect-force-update';
  }
  if (input.inForceUpdate) {
    return 'exit-force-update';
  }
  if (!input.hasToken) {
    return input.inAuthGroup ? 'settle-login' : 'redirect-login';
  }
  if (input.userIdError) {
    return 'settle-user-error';
  }
  if (input.consentCheckError) {
    return 'settle-consent-error';
  }
  if (input.userIdLoading || !input.consentChecked) {
    return 'wait-user-consent';
  }
  if (input.needsConsent) {
    return input.onConsentRoute ? 'settle-consent' : 'redirect-consent';
  }
  if ((input.onConsentRoute && !input.onConsentReviewRoute) || input.inAuthGroup) {
    return 'redirect-app';
  }
  return 'settle-app';
}

export function resolveBootstrapDecision(input: BootstrapDecisionInput): BootstrapDecision {
  const hasUserBootstrapError = input.hasToken && input.userIdError;
  const hasConsentBootstrapError = input.hasToken && input.consentCheckError;
  const hasBootstrapError = hasUserBootstrapError || hasConsentBootstrapError;
  const consentLoading =
    input.hasToken &&
    !input.consentChecked &&
    !input.inAuthGroup &&
    !input.inForceUpdate &&
    !input.onConsentRoute;
  const needsForceUpdate = input.updateRequired && !input.inForceUpdate;
  const showingForceUpdate = input.updateRequired && input.inForceUpdate;
  const needsAuth = !input.hasToken && !input.inAuthGroup;
  const needsAppRedirect = input.hasToken && input.inAuthGroup;
  const needsConsentRedirect = input.consentChecked && input.needsConsent && !input.onConsentRoute;
  const needsRedirect =
    !input.isLoading &&
    (needsForceUpdate ||
      (!showingForceUpdate && (needsAuth || needsAppRedirect || needsConsentRedirect)));
  const hidden =
    !hasUserBootstrapError &&
    !hasConsentBootstrapError &&
    (input.isLoading || needsRedirect || consentLoading);

  return {
    tag: resolveBootstrapTag(input),
    hasUserBootstrapError,
    hasConsentBootstrapError,
    hasBootstrapError,
    hidden,
  };
}

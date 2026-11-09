import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import {
  type PendingLinkFailureReason,
  type PendingLinkOffer,
  type PendingLinkResult,
} from '@/lib/auth/native-auth-contract';
import { providerLabel } from '@/lib/auth/provider-label';

/** The controls the pending-link screen offers to prove ownership of the existing account. */
export type PendingLinkOptions = {
  apple: boolean;
  google: boolean;
  passkey: boolean;
  emailCode: boolean;
  browser: boolean;
};

/** A refusal from a resolving sign-in, and whether another attempt can change it. */
export type PendingLinkFailure = { message: string; retryable: boolean };

export type PendingLinkView =
  | { kind: 'expired'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'options'; error: string | undefined };

const FAILURE_KEYS = {
  EXPIRED: 'pendingLink.failedExpired',
  WRONG_ACCOUNT: 'pendingLink.failedWrongAccount',
  'ACCOUNT-ALREADY-LINKED': 'pendingLink.failedAccountAlreadyLinked',
  'PROVIDER-ALREADY-LINKED': 'pendingLink.failedProviderAlreadyLinked',
  'LINKING-FAILED': 'pendingLink.failedLinking',
} as const satisfies Record<PendingLinkFailureReason, string>;

/** The request-body field that ties a sign-in to the pending link it resolves. */
export function pendingLinkTokenBody(offer: PendingLinkOffer | null | undefined) {
  return offer ? { pendingLinkToken: offer.token } : {};
}

/**
 * Apple, Google and passkey run natively only where this device can run them. Every other
 * method the account has, those three included when the device cannot run them, goes through
 * the browser sign-in. The email code stands in for an `email` method.
 */
export function pendingLinkOptions(
  offer: PendingLinkOffer,
  device: { apple: boolean; google: boolean; passkey: boolean }
): PendingLinkOptions {
  const apple = device.apple && offer.methods.includes('apple');
  const google = device.google && offer.methods.includes('google');
  const passkey = device.passkey && offer.methods.includes('passkey');
  const browser = offer.methods.some(
    method =>
      !(
        (method === 'apple' && apple) ||
        (method === 'google' && google) ||
        (method === 'passkey' && passkey) ||
        (method === 'email' && offer.emailCode)
      )
  );
  return { apple, google, passkey, emailCode: offer.emailCode, browser };
}

/** BLOCKED and ADMISSION_REQUIRED refuse every sign-in method, so offering the methods again cannot help. */
export function pendingLinkFailure(
  message: string,
  errorCode: string | undefined
): PendingLinkFailure {
  return { message, retryable: errorCode !== 'BLOCKED' && errorCode !== 'ADMISSION_REQUIRED' };
}

export function resolvePendingLinkView(params: {
  offer: PendingLinkOffer;
  options: PendingLinkOptions;
  expired: boolean;
  failure: PendingLinkFailure | undefined;
}): PendingLinkView {
  const { offer, options, expired, failure } = params;
  const provider = providerLabel(offer.provider);
  if (expired) {
    return { kind: 'expired', message: i18n.t('pendingLink.expired', { provider }) };
  }
  if (failure && !failure.retryable) {
    return { kind: 'unavailable', message: failure.message };
  }
  if (!Object.values(options).some(Boolean)) {
    return { kind: 'unavailable', message: i18n.t('pendingLink.noMethods', { provider }) };
  }
  return { kind: 'options', error: failure?.message };
}

/**
 * Tells the person, without blocking, what happened to the pending link a completed sign-in
 * carried. The sign-in stands either way. A failed result names no provider, so the offer the
 * request carried supplies it.
 */
export function announcePendingLinkResult(
  result: PendingLinkResult | undefined,
  offer: PendingLinkOffer | null
): void {
  if (result?.status === 'linked') {
    announcingToast.success(
      i18n.t('pendingLink.linked', { provider: providerLabel(result.provider) })
    );
    return;
  }
  if (result?.status === 'failed' && offer) {
    announcingToast.warning(
      i18n.t(FAILURE_KEYS[result.reason], { provider: providerLabel(offer.provider) })
    );
  }
}

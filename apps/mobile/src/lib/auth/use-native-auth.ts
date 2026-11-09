/* eslint-disable max-lines -- the hook owns the Apple, Google, passkey, and email-OTP paths in one place so they share the busy guard and the error mapping */
import * as AppleAuthentication from 'expo-apple-authentication';
import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytesAsync } from 'expo-crypto';
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { toast } from 'sonner-native';

import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { z } from 'zod';

import { i18n } from '@/i18n';
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from '@/lib/config';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useAuth } from '@/lib/auth/auth-context';
import {
  type AuthErrorMessageKey,
  defaultErrorMessage,
  mapError,
  mapErrorKey,
  signupStepUpMessage,
} from '@/lib/auth/auth-error-messages';
import { hasStringCode, postAuth, type PostAuthFailure } from '@/lib/auth/auth-fetch';
import {
  buildChallengeEntry,
  parseEmailCodeResponse,
  parseTokenPair,
  type PendingLinkOffer,
  type PendingLinkResult,
  selectChallengeId,
} from '@/lib/auth/native-auth-contract';
import {
  passkeyFailureKey,
  signInWithPasskey as runPasskeySignIn,
} from '@/lib/auth/passkey-client';
import {
  announcePendingLinkResult,
  type PendingLinkFailure,
  pendingLinkFailure,
  pendingLinkTokenBody,
} from '@/lib/auth/pending-link';
import { resolveAdmission } from '@/lib/auth/resolve-admission';
import { type SsoRecovery, useSsoRecovery } from '@/lib/auth/use-sso-recovery';

// Match the OTP route's syntax check and bound the mobile address length
// before delivery, keeping validation beside the email field.
const emailAddressSchema = z.email().max(254);

// Module-level guard — GoogleSignin.configure() is cheap but re-calling it
// on every button press is pointless; upgrade to a re-configure path if client IDs
// ever need to change at runtime.
let googleSignInConfigured = false;

function ensureGoogleConfigured() {
  if (googleSignInConfigured) {
    return;
  }
  GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    iosClientId: GOOGLE_IOS_CLIENT_ID,
    offlineAccess: true,
  });
  googleSignInConfigured = true;
}

/**
 * A token-route refusal in the active language. A signup step-up names an allowed Apple or
 * Google button only when this screen shows it; the Apple check is the one the screen makes.
 */
async function tokenRefusalMessage(
  result: PostAuthFailure,
  googleConfigured: boolean
): Promise<string> {
  if (result.errorCode !== 'SIGNUP-STEP-UP') {
    return mapError(result.errorCode);
  }
  const apple =
    Platform.OS === 'ios' && (await AppleAuthentication.isAvailableAsync().catch(() => false));
  return signupStepUpMessage(result.signupMethods, { apple, google: googleConfigured });
}

export type BusyAction = 'apple' | 'google' | 'passkey' | 'otp-send' | 'otp-verify' | undefined;

/** Outcome of an email-code verification attempt: a token, or an inline refusal message. */
type EmailCodeVerifyResult = { ok: true } | { ok: false; message: string };

/** The email-field error keys the inline slot can carry; translated at render. */
type EmailErrorKey = 'login.pleaseEnterEmail' | AuthErrorMessageKey;

type NativeAuthResult = {
  busy: BusyAction;
  emailErrorKey: EmailErrorKey | undefined;
  clearEmailError: () => void;
  googleConfigured: boolean;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signInWithPasskey: () => Promise<void>;
  requestEmailCode: (email: string) => Promise<boolean>;
  verifyEmailCode: (email: string, code: string) => Promise<EmailCodeVerifyResult>;
  ssoRecovery: SsoRecovery | null;
  clearSsoRecovery: () => void;
  handleSsoError: (email: string, ssoOrganizationId: string | undefined) => void;
  /** The last refusal while a pending link is being resolved; that screen shows it inline. */
  pendingLinkFailure: PendingLinkFailure | undefined;
};

type PendingLinkBinding = {
  /** The pending link the screen is resolving; every sign-in request carries its token. */
  pendingLink: PendingLinkOffer | null;
  /** Receives the pending link a `DIFFERENT-OAUTH` refusal offers. */
  onPendingLinkOffer: (offer: PendingLinkOffer) => void;
};

/**
 * Without a binding the hook keeps the plain sign-in behavior: a `DIFFERENT-OAUTH` refusal is a
 * toast even when the server offered a pending link.
 */
export function useNativeAuth(binding?: PendingLinkBinding): NativeAuthResult {
  const { signIn } = useAuth();
  const pendingLink = binding?.pendingLink ?? null;
  const onPendingLinkOffer = binding?.onPendingLinkOffer;
  const [busy, setBusy] = useState<BusyAction>(undefined);
  const [emailErrorKey, setEmailErrorKey] = useState<EmailErrorKey | undefined>(undefined);
  const [linkFailure, setLinkFailure] = useState<PendingLinkFailure | undefined>(undefined);
  const busyRef = useRef<BusyAction>(undefined);
  const challengeRef = useRef<{ email: string; challengeId: string } | null>(null);
  const { ssoRecovery, clearSsoRecovery, handleSsoError } = useSsoRecovery();

  const clearEmailError = useCallback(() => {
    setEmailErrorKey(undefined);
  }, []);

  const startAction = useCallback(
    (action: Exclude<BusyAction, undefined>) => {
      if (busyRef.current) {
        return false;
      }
      busyRef.current = action;
      setBusy(action);
      clearEmailError();
      clearSsoRecovery();
      setLinkFailure(undefined);
      return true;
    },
    [clearEmailError, clearSsoRecovery]
  );

  const finishAction = useCallback((action: Exclude<BusyAction, undefined>) => {
    if (busyRef.current === action) {
      busyRef.current = undefined;
      setBusy(undefined);
    }
  }, []);

  const googleConfigured =
    Boolean(GOOGLE_WEB_CLIENT_ID) && (Platform.OS !== 'ios' || Boolean(GOOGLE_IOS_CLIENT_ID));

  // The landing toasts a refusal; the pending-link screen keeps it inline beside its options.
  const reportFailure = useCallback(
    (message: string, errorCode?: string) => {
      if (pendingLink) {
        setLinkFailure(pendingLinkFailure(message, errorCode));
        return;
      }
      toast.error(message);
    },
    [pendingLink]
  );

  const takePendingLinkOffer = useCallback(
    (result: PostAuthFailure) => {
      if (result.errorCode !== 'DIFFERENT-OAUTH' || !result.pendingLink || !onPendingLinkOffer) {
        return false;
      }
      onPendingLinkOffer(result.pendingLink);
      return true;
    },
    [onPendingLinkOffer]
  );

  const announceSignedIn = useCallback(
    (outcome: { created?: boolean; pendingLink?: PendingLinkResult }) => {
      if (outcome.created === true) {
        announcingToast.success(i18n.t('login.accountCreated'));
      }
      announcePendingLinkResult(outcome.pendingLink, pendingLink);
    },
    [pendingLink]
  );

  const signInWithApple = useCallback(async () => {
    if (!startAction('apple')) {
      return;
    }
    try {
      // Generate a raw nonce and its SHA-256 digest.  The digest is passed to
      // AppleAuthentication.signInAsync.  Apple embeds the digest in the identity
      // token payload as-is.  The server must compute SHA-256 of the raw nonce
      // and compare against payload.nonce.
      const rawNonceBytes = await getRandomBytesAsync(32);
      const rawNonce = [...rawNonceBytes].map(b => b.toString(16).padStart(2, '0')).join('');
      const nonceDigest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, rawNonce);

      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: nonceDigest,
      });

      if (!credential.identityToken) {
        reportFailure(defaultErrorMessage());
        return;
      }

      // fullName is only populated on the user's FIRST authorization ever.
      const fullName = credential.fullName
        ? AppleAuthentication.formatFullName(credential.fullName) || undefined
        : undefined;

      let admissionBody: Record<string, unknown> = {};
      try {
        admissionBody = await resolveAdmission();
      } catch {
        return;
      }

      const result = await postAuth('/api/auth/native/token', {
        provider: 'apple',
        ...admissionBody,
        idToken: credential.identityToken,
        nonce: rawNonce,
        supportsRefresh: true,
        ...(fullName ? { fullName } : {}),
        ...pendingLinkTokenBody(pendingLink),
      });

      if (result.ok) {
        const parsed = parseTokenPair(result.data);
        if (!parsed) {
          reportFailure(defaultErrorMessage());
          return;
        }
        await signIn(
          parsed.token,
          'refreshToken' in parsed ? parsed.refreshToken : undefined,
          'expiresIn' in parsed ? parsed.expiresIn : undefined
        );
        announceSignedIn(parsed);
      } else if (result.errorCode === 'SSO_ERROR') {
        handleSsoError(credential.email ?? '', result.ssoOrganizationId);
      } else if (!takePendingLinkOffer(result)) {
        reportFailure(mapError(result.errorCode), result.errorCode);
      }
    } catch (error) {
      if (hasStringCode(error) && error.code === 'ERR_REQUEST_CANCELED') {
        return;
      }
      reportFailure(defaultErrorMessage());
    } finally {
      finishAction('apple');
    }
  }, [
    announceSignedIn,
    finishAction,
    handleSsoError,
    pendingLink,
    reportFailure,
    signIn,
    startAction,
    takePendingLinkOffer,
  ]);

  const signInWithGoogle = useCallback(async () => {
    if (!startAction('google')) {
      return;
    }
    try {
      ensureGoogleConfigured();
      // Android: surfaces the "update Play Services" prompt instead of a cryptic failure; no-op on iOS.
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const response = await GoogleSignin.signIn();

      if (response.type === 'cancelled') {
        return;
      }

      const serverAuthCode = response.data.serverAuthCode;
      const idToken = response.data.idToken;

      if (!serverAuthCode && !idToken) {
        reportFailure(defaultErrorMessage());
        return;
      }

      let admissionBody: Record<string, unknown> = {};
      try {
        admissionBody = await resolveAdmission();
      } catch {
        return;
      }

      const result = await postAuth('/api/auth/native/token', {
        provider: 'google',
        supportsRefresh: true,
        ...(serverAuthCode
          ? { serverAuthCode, googleClientId: GOOGLE_WEB_CLIENT_ID }
          : { idToken }),
        ...admissionBody,
        ...pendingLinkTokenBody(pendingLink),
      });

      if (result.ok) {
        const parsed = parseTokenPair(result.data);
        if (!parsed) {
          reportFailure(defaultErrorMessage());
          return;
        }
        await signIn(
          parsed.token,
          'refreshToken' in parsed ? parsed.refreshToken : undefined,
          'expiresIn' in parsed ? parsed.expiresIn : undefined
        );
        announceSignedIn(parsed);
      } else if (result.errorCode === 'SSO_ERROR') {
        handleSsoError(response.data.user.email, result.ssoOrganizationId);
      } else if (!takePendingLinkOffer(result)) {
        reportFailure(await tokenRefusalMessage(result, googleConfigured), result.errorCode);
      }
    } catch {
      reportFailure(defaultErrorMessage());
    } finally {
      finishAction('google');
    }
  }, [
    announceSignedIn,
    finishAction,
    googleConfigured,
    handleSsoError,
    pendingLink,
    reportFailure,
    signIn,
    startAction,
    takePendingLinkOffer,
  ]);

  const signInWithPasskey = useCallback(async () => {
    if (!startAction('passkey')) {
      return;
    }
    try {
      const result = await runPasskeySignIn(undefined, pendingLink?.token);
      if (result.status === 'ok') {
        await signIn(result.token, result.refreshToken, result.expiresIn);
        announceSignedIn(result);
        return;
      }
      if (result.reported) {
        // The failure already showed its own message; a second toast would only
        // repeat it.
        return;
      }
      if (result.errorCode === 'SSO_ERROR') {
        // A forced-SSO refusal is the same gate Apple, Google, and the email
        // code take: offer the SSO recovery block instead of a toast. The
        // usernameless ceremony names no address, so the block is seeded with
        // the empty email Apple's credential omits on a later sign-in.
        handleSsoError('', result.ssoOrganizationId);
        return;
      }
      reportFailure(
        result.errorCode ? mapError(result.errorCode) : i18n.t(passkeyFailureKey(result.failure)),
        result.errorCode
      );
    } catch (error) {
      // eslint-disable-next-line no-console -- surface swallowed auth errors to Sentry
      console.error('[native-auth] signInWithPasskey failed:', error);
      reportFailure(defaultErrorMessage());
    } finally {
      finishAction('passkey');
    }
  }, [
    announceSignedIn,
    finishAction,
    handleSsoError,
    pendingLink,
    reportFailure,
    signIn,
    startAction,
  ]);

  const requestEmailCode = useCallback(
    async (rawEmail: string) => {
      const email = rawEmail.trim().toLowerCase();
      if (!email) {
        setEmailErrorKey('login.pleaseEnterEmail');
        return false;
      }
      if (!emailAddressSchema.safeParse(email).success) {
        setEmailErrorKey(mapErrorKey('INVALID_REQUEST'));
        return false;
      }

      if (!startAction('otp-send')) {
        // Refused because another auth action is in flight. Tell the user why
        // instead of returning a silent false that leaves the button dead.
        toast.error(i18n.t('login.couldNotCompleteSignIn'));
        return false;
      }
      try {
        const result = await postAuth('/api/auth/native/otp', { email });
        if (!result.ok) {
          if (result.errorCode === 'SSO_ERROR') {
            handleSsoError(email, result.ssoOrganizationId);
          } else if (
            result.errorCode === 'INVALID_REQUEST' ||
            result.errorCode === 'INVALID_EMAIL'
          ) {
            setEmailErrorKey(mapErrorKey(result.errorCode));
          } else {
            reportFailure(mapError(result.errorCode), result.errorCode);
          }
          return false;
        }
        const parsed = parseEmailCodeResponse(result.data);
        if (!parsed) {
          reportFailure(defaultErrorMessage());
          return false;
        }
        // Hold the challenge for the current email so verifyEmailCode can
        // send it back. Discard a stale challenge when the email changes:
        // a code requested for one address must never be verified against
        // another's challenge.
        challengeRef.current = buildChallengeEntry(parsed, email);
        return true;
      } finally {
        finishAction('otp-send');
      }
    },
    [finishAction, handleSsoError, reportFailure, startAction]
  );

  const verifyEmailCode = useCallback(
    async (rawEmail: string, code: string): Promise<EmailCodeVerifyResult> => {
      const email = rawEmail.trim().toLowerCase();
      if (!startAction('otp-verify')) {
        return { ok: false, message: i18n.t('login.couldNotCompleteSignIn') };
      }
      try {
        // Only send a challengeId when the email matches. A mismatched
        // email means the challenge was generated for a different address.
        const challengeId = selectChallengeId(challengeRef.current, email);

        let admissionBody: Record<string, unknown> = {};
        try {
          admissionBody = await resolveAdmission();
        } catch {
          return { ok: false, message: i18n.t('authErrors.retryableAdmission') };
        }

        const result = await postAuth('/api/auth/native/token', {
          provider: 'email',
          ...admissionBody,
          email,
          code,
          supportsRefresh: true,
          ...(challengeId ? { challengeId } : {}),
          ...pendingLinkTokenBody(pendingLink),
        });
        if (!result.ok) {
          if (result.errorCode === 'SSO_ERROR') {
            handleSsoError(email, result.ssoOrganizationId);
          }
          // An offered pending link replaces the code step with its own screen.
          takePendingLinkOffer(result);
          // Every other refusal surfaces inline on the code step: the form owns
          // the message slot, so a wrong, spent, or contested code reads in the
          // active language right where the input is. A toast here was the
          // reported dead end — the screen kept its silence while the toast
          // could land behind the keyboard or expire unnoticed.
          return { ok: false, message: await tokenRefusalMessage(result, googleConfigured) };
        }
        const parsed = parseTokenPair(result.data);
        if (!parsed) {
          return { ok: false, message: defaultErrorMessage() };
        }
        await signIn(
          parsed.token,
          'refreshToken' in parsed ? parsed.refreshToken : undefined,
          'expiresIn' in parsed ? parsed.expiresIn : undefined
        );
        announceSignedIn(parsed);
        return { ok: true };
      } catch (error) {
        // eslint-disable-next-line no-console -- surface swallowed auth errors to Sentry
        console.error('[native-auth] verifyEmailCode signIn failed:', error);
        return { ok: false, message: defaultErrorMessage() };
      } finally {
        finishAction('otp-verify');
      }
    },
    [
      announceSignedIn,
      finishAction,
      googleConfigured,
      handleSsoError,
      pendingLink,
      signIn,
      startAction,
      takePendingLinkOffer,
    ]
  );

  return {
    busy,
    emailErrorKey,
    clearEmailError,
    googleConfigured,
    signInWithApple,
    signInWithGoogle,
    signInWithPasskey,
    requestEmailCode,
    verifyEmailCode,
    ssoRecovery,
    clearSsoRecovery,
    handleSsoError,
    pendingLinkFailure: linkFailure,
  };
}

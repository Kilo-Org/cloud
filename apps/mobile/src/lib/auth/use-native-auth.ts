/* eslint-disable max-lines -- the hook owns the Apple, Google, passkey, and email-OTP paths in one place so they share the busy guard and the error mapping */
import * as AppleAuthentication from 'expo-apple-authentication';
import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytesAsync } from 'expo-crypto';
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { toast } from 'sonner-native';

import { GoogleSignin } from '@react-native-google-signin/google-signin';

import { i18n } from '@/i18n';
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from '@/lib/config';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useAuth } from '@/lib/auth/auth-context';
import { defaultErrorMessage, mapError } from '@/lib/auth/auth-error-messages';
import { hasStringCode, postAuth } from '@/lib/auth/auth-fetch';
import {
  buildChallengeEntry,
  parseEmailCodeResponse,
  parseTokenPair,
  selectChallengeId,
} from '@/lib/auth/native-auth-contract';
import {
  passkeyFailureKey,
  signInWithPasskey as runPasskeySignIn,
} from '@/lib/auth/passkey-client';
import { resolveAdmission } from '@/lib/auth/resolve-admission';
import { type SsoRecovery, useSsoRecovery } from '@/lib/auth/use-sso-recovery';

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

type BusyAction = 'apple' | 'google' | 'passkey' | 'otp-send' | 'otp-verify' | undefined;

type NativeAuthResult = {
  busy: BusyAction;
  emailError: string | undefined;
  clearEmailError: () => void;
  googleConfigured: boolean;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signInWithPasskey: () => Promise<void>;
  requestEmailCode: (email: string) => Promise<boolean>;
  verifyEmailCode: (email: string, code: string) => Promise<boolean>;
  ssoRecovery: SsoRecovery | null;
  clearSsoRecovery: () => void;
  handleSsoError: (email: string, ssoOrganizationId: string | undefined) => void;
};

export function useNativeAuth(): NativeAuthResult {
  const { signIn } = useAuth();
  const [busy, setBusy] = useState<BusyAction>(undefined);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const busyRef = useRef<BusyAction>(undefined);
  const challengeRef = useRef<{ email: string; challengeId: string } | null>(null);
  const { ssoRecovery, clearSsoRecovery, handleSsoError } = useSsoRecovery();

  const clearEmailError = useCallback(() => {
    setEmailError(undefined);
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
        toast.error(defaultErrorMessage());
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
      });

      if (result.ok) {
        const parsed = parseTokenPair(result.data);
        if (!parsed) {
          toast.error(defaultErrorMessage());
          return;
        }
        await signIn(
          parsed.token,
          'refreshToken' in parsed ? parsed.refreshToken : undefined,
          'expiresIn' in parsed ? parsed.expiresIn : undefined
        );
        if (parsed.created === true) {
          announcingToast.success(i18n.t('login.accountCreated'));
        }
      } else if (result.errorCode === 'SSO_ERROR') {
        handleSsoError(credential.email ?? '', result.ssoOrganizationId);
      } else {
        toast.error(mapError(result.errorCode));
      }
    } catch (error) {
      if (hasStringCode(error) && error.code === 'ERR_REQUEST_CANCELED') {
        return;
      }
      toast.error(defaultErrorMessage());
    } finally {
      finishAction('apple');
    }
  }, [finishAction, handleSsoError, signIn, startAction]);

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
        toast.error(defaultErrorMessage());
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
      });

      if (result.ok) {
        const parsed = parseTokenPair(result.data);
        if (!parsed) {
          toast.error(defaultErrorMessage());
          return;
        }
        await signIn(
          parsed.token,
          'refreshToken' in parsed ? parsed.refreshToken : undefined,
          'expiresIn' in parsed ? parsed.expiresIn : undefined
        );
        if (parsed.created === true) {
          announcingToast.success(i18n.t('login.accountCreated'));
        }
      } else if (result.errorCode === 'SSO_ERROR') {
        handleSsoError(response.data.user.email, result.ssoOrganizationId);
      } else {
        toast.error(mapError(result.errorCode));
      }
    } catch {
      toast.error(defaultErrorMessage());
    } finally {
      finishAction('google');
    }
  }, [finishAction, handleSsoError, signIn, startAction]);

  const signInWithPasskey = useCallback(async () => {
    if (!startAction('passkey')) {
      return;
    }
    try {
      const result = await runPasskeySignIn();
      if (result.status === 'ok') {
        await signIn(result.token, result.refreshToken, result.expiresIn);
        if (result.created === true) {
          announcingToast.success(i18n.t('login.accountCreated'));
        }
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
      toast.error(
        result.errorCode ? mapError(result.errorCode) : i18n.t(passkeyFailureKey(result.failure))
      );
    } catch (error) {
      // eslint-disable-next-line no-console -- surface swallowed auth errors to Sentry
      console.error('[native-auth] signInWithPasskey failed:', error);
      toast.error(defaultErrorMessage());
    } finally {
      finishAction('passkey');
    }
  }, [finishAction, handleSsoError, signIn, startAction]);

  const requestEmailCode = useCallback(
    async (rawEmail: string) => {
      const email = rawEmail.trim().toLowerCase();
      if (!email) {
        setEmailError(i18n.t('login.pleaseEnterEmail'));
        return false;
      }

      if (!startAction('otp-send')) {
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
            setEmailError(mapError(result.errorCode));
          } else {
            toast.error(mapError(result.errorCode));
          }
          return false;
        }
        const parsed = parseEmailCodeResponse(result.data);
        if (!parsed) {
          toast.error(defaultErrorMessage());
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
    [finishAction, handleSsoError, startAction]
  );

  const verifyEmailCode = useCallback(
    async (rawEmail: string, code: string) => {
      const email = rawEmail.trim().toLowerCase();
      if (!startAction('otp-verify')) {
        return false;
      }
      try {
        // Only send a challengeId when the email matches. A mismatched
        // email means the challenge was generated for a different address.
        const challengeId = selectChallengeId(challengeRef.current, email);

        let admissionBody: Record<string, unknown> = {};
        try {
          admissionBody = await resolveAdmission();
        } catch {
          return false;
        }

        const result = await postAuth('/api/auth/native/token', {
          provider: 'email',
          ...admissionBody,
          email,
          code,
          supportsRefresh: true,
          ...(challengeId ? { challengeId } : {}),
        });
        if (!result.ok) {
          if (result.errorCode === 'SSO_ERROR') {
            handleSsoError(email, result.ssoOrganizationId);
          } else {
            toast.error(mapError(result.errorCode));
          }
          return false;
        }
        const parsed = parseTokenPair(result.data);
        if (!parsed) {
          toast.error(defaultErrorMessage());
          return false;
        }
        await signIn(
          parsed.token,
          'refreshToken' in parsed ? parsed.refreshToken : undefined,
          'expiresIn' in parsed ? parsed.expiresIn : undefined
        );
        if (parsed.created === true) {
          announcingToast.success(i18n.t('login.accountCreated'));
        }
        return true;
      } catch (error) {
        // eslint-disable-next-line no-console -- surface swallowed auth errors to Sentry
        console.error('[native-auth] verifyEmailCode signIn failed:', error);
        toast.error(defaultErrorMessage());
        return false;
      } finally {
        finishAction('otp-verify');
      }
    },
    [finishAction, handleSsoError, signIn, startAction]
  );

  return {
    busy,
    emailError,
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
  };
}

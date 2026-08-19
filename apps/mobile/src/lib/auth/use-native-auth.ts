import * as AppleAuthentication from 'expo-apple-authentication';
import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytesAsync } from 'expo-crypto';
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { toast } from 'sonner-native';

import { GoogleSignin } from '@react-native-google-signin/google-signin';

import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from '@/lib/config';
import { useAuth } from '@/lib/auth/auth-context';
import { hasStringCode, postAuth } from '@/lib/auth/auth-fetch';
import {
  ADMISSION_CHALLENGE_FAILED,
  type AdmissionPayload,
  getAdmission,
} from '@/lib/auth/admission';
import {
  buildChallengeEntry,
  parseEmailCodeResponse,
  parseTokenPair,
  selectChallengeId,
} from '@/lib/auth/native-auth-contract';

export const AUTH_ERROR_MESSAGES = {
  'EMAIL-ALREADY-USED':
    "An account with this email already exists with a different sign-in method. Try another method or use 'More sign-in options'.",
  'DIFFERENT-OAUTH':
    "An account with this email already exists with a different sign-in method. Try another method or use 'More sign-in options'.",
  SSO_ERROR: "Your organization requires SSO. Use 'More sign-in options'.",
  // Only surfaced by Apple/Google paths; the email-OTP request returns opaque 200 for blocked domains
  BLOCKED: 'This account has been blocked. Please contact support.',
  'SIGNUP-RATE-LIMITED': 'Too many attempts. Please try again later.',
  INVALID_CODE: 'That code is incorrect. Please try again.',
  CODE_IN_PROGRESS: 'Your code is being processed. Wait a moment and try again.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Please request a new code.',
  INVALID_TOKEN: 'Sign-in failed. Please try again.',
  INVALID_EMAIL: 'Unable to deliver email to this address. Please use a different email.',
  INVALID_REQUEST: 'Check your email address and try again.',
  EMAIL_DELIVERY_FAILED: 'Email delivery is temporarily unavailable. Please try again later.',
  // Admission: server refuses the device under enforce mode — non-retryable.
  ADMISSION_REQUIRED:
    "Your device can't be verified. Use 'More sign-in options' to sign in on another device or through the web.",
} satisfies Record<string, string>;

export const DEFAULT_ERROR_MESSAGE = 'Something went wrong. Please try again.';
export const RETRYABLE_ADMISSION_ERROR =
  'We could not verify this device. Check your connection and try again.';

export function mapError(errorCode: string | undefined): string {
  return (
    (errorCode && AUTH_ERROR_MESSAGES[errorCode as keyof typeof AUTH_ERROR_MESSAGES]) ??
    DEFAULT_ERROR_MESSAGE
  );
}

export async function resolveAdmission(): Promise<
  { admission: AdmissionPayload } | { admission: undefined }
> {
  try {
    const admission = await getAdmission();
    if (admission) {
      return { admission };
    }
    return { admission: undefined };
  } catch {
    // Normalize every challenge/provider failure to the retryable message.
    // Network errors, JSON parse failures, and !response.ok all abort sign-in;
    // every path must show the retryable toast and throw a consistent sentinel.
    toast.error(RETRYABLE_ADMISSION_ERROR);
    throw new Error(ADMISSION_CHALLENGE_FAILED);
  }
}

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

type BusyAction = 'apple' | 'google' | 'otp-send' | 'otp-verify' | undefined;

type NativeAuthResult = {
  busy: BusyAction;
  googleConfigured: boolean;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  requestEmailCode: (email: string) => Promise<boolean>;
  verifyEmailCode: (email: string, code: string) => Promise<boolean>;
};

export function useNativeAuth(): NativeAuthResult {
  const { signIn } = useAuth();
  const [busy, setBusy] = useState<BusyAction>(undefined);
  const busyRef = useRef<BusyAction>(undefined);
  const challengeRef = useRef<{ email: string; challengeId: string } | null>(null);

  const startAction = useCallback((action: Exclude<BusyAction, undefined>) => {
    if (busyRef.current) {
      return false;
    }
    busyRef.current = action;
    setBusy(action);
    return true;
  }, []);

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
        toast.error(DEFAULT_ERROR_MESSAGE);
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
          toast.error(DEFAULT_ERROR_MESSAGE);
          return;
        }
        await signIn(
          parsed.token,
          'refreshToken' in parsed ? parsed.refreshToken : undefined,
          'expiresIn' in parsed ? parsed.expiresIn : undefined
        );
      } else {
        toast.error(mapError(result.errorCode));
      }
    } catch (error) {
      if (hasStringCode(error) && error.code === 'ERR_REQUEST_CANCELED') {
        return;
      }
      toast.error(DEFAULT_ERROR_MESSAGE);
    } finally {
      finishAction('apple');
    }
  }, [finishAction, signIn, startAction]);

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
        toast.error(DEFAULT_ERROR_MESSAGE);
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
          toast.error(DEFAULT_ERROR_MESSAGE);
          return;
        }
        await signIn(
          parsed.token,
          'refreshToken' in parsed ? parsed.refreshToken : undefined,
          'expiresIn' in parsed ? parsed.expiresIn : undefined
        );
      } else {
        toast.error(mapError(result.errorCode));
      }
    } catch {
      toast.error(DEFAULT_ERROR_MESSAGE);
    } finally {
      finishAction('google');
    }
  }, [finishAction, signIn, startAction]);

  const requestEmailCode = useCallback(
    async (rawEmail: string) => {
      const email = rawEmail.trim().toLowerCase();
      if (!email) {
        toast.error('Please enter your email address.');
        return false;
      }

      if (!startAction('otp-send')) {
        return false;
      }
      try {
        const result = await postAuth('/api/auth/native/otp', { email });
        if (!result.ok) {
          toast.error(mapError(result.errorCode));
          return false;
        }
        const parsed = parseEmailCodeResponse(result.data);
        if (!parsed) {
          toast.error(DEFAULT_ERROR_MESSAGE);
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
    [finishAction, startAction]
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
          toast.error(mapError(result.errorCode));
          return false;
        }
        const parsed = parseTokenPair(result.data);
        if (!parsed) {
          toast.error(DEFAULT_ERROR_MESSAGE);
          return false;
        }
        await signIn(
          parsed.token,
          'refreshToken' in parsed ? parsed.refreshToken : undefined,
          'expiresIn' in parsed ? parsed.expiresIn : undefined
        );
        return true;
      } catch (error) {
        // eslint-disable-next-line no-console -- surface swallowed auth errors to Sentry
        console.error('[native-auth] verifyEmailCode signIn failed:', error);
        toast.error(DEFAULT_ERROR_MESSAGE);
        return false;
      } finally {
        finishAction('otp-verify');
      }
    },
    [finishAction, signIn, startAction]
  );

  return {
    busy,
    googleConfigured,
    signInWithApple,
    signInWithGoogle,
    requestEmailCode,
    verifyEmailCode,
  };
}

import * as AppleAuthentication from 'expo-apple-authentication';
import { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import { toast } from 'sonner-native';

import { GoogleSignin } from '@react-native-google-signin/google-signin';

import { API_BASE_URL, GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from '@/lib/config';
import { useAuth } from '@/lib/auth/auth-context';

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  'EMAIL-ALREADY-USED':
    "An account with this email already exists with a different sign-in method. Try another method or use 'More sign-in options'.",
  'DIFFERENT-OAUTH':
    "An account with this email already exists with a different sign-in method. Try another method or use 'More sign-in options'.",
  SSO_ERROR: "Your organization requires SSO. Use 'More sign-in options'.",
  BLOCKED: 'This account has been blocked. Please contact support.',
  'SIGNUP-RATE-LIMITED': 'Too many attempts. Please try again later.',
  INVALID_CODE: 'That code is incorrect. Please try again.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Please request a new code.',
  INVALID_TOKEN: 'Sign-in failed. Please try again.',
};

const DEFAULT_ERROR_MESSAGE = 'Something went wrong. Please try again.';

function mapError(errorCode: string | undefined): string {
  return (errorCode && AUTH_ERROR_MESSAGES[errorCode]) ?? DEFAULT_ERROR_MESSAGE;
}

// ponytail: only the callers we have need the error code + parsed body; a generic
// fetch client would be speculative for two endpoints.
async function postAuth(
  path: string,
  body: unknown
): Promise<{ ok: true; data: unknown } | { ok: false; errorCode: string | undefined }> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    let json: unknown = undefined;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      const errorCode =
        typeof json === 'object' &&
        json !== null &&
        typeof (json as { error?: unknown }).error === 'string'
          ? (json as { error: string }).error
          : undefined;
      return { ok: false, errorCode };
    }

    return { ok: true, data: json };
  } catch {
    return { ok: false, errorCode: undefined };
  }
}

function hasStringCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

// ponytail: module-level guard — GoogleSignin.configure() is cheap but re-calling it
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
  });
  googleSignInConfigured = true;
}

type BusyAction = 'apple' | 'google' | 'otp-send' | 'otp-verify' | undefined;

type TokenResponse = { token: string };

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

  const googleConfigured =
    Boolean(GOOGLE_WEB_CLIENT_ID) && (Platform.OS !== 'ios' || Boolean(GOOGLE_IOS_CLIENT_ID));

  const signInWithApple = useCallback(async () => {
    setBusy('apple');
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      if (!credential.identityToken) {
        toast.error(DEFAULT_ERROR_MESSAGE);
        return;
      }

      // fullName is only populated on the user's FIRST authorization ever.
      const fullName = credential.fullName
        ? AppleAuthentication.formatFullName(credential.fullName) || undefined
        : undefined;

      const result = await postAuth('/api/auth/native/token', {
        provider: 'apple',
        idToken: credential.identityToken,
        ...(fullName ? { fullName } : {}),
      });

      if (result.ok) {
        await signIn((result.data as TokenResponse).token);
      } else {
        toast.error(mapError(result.errorCode));
      }
    } catch (error) {
      if (hasStringCode(error) && error.code === 'ERR_REQUEST_CANCELED') {
        return;
      }
      toast.error(DEFAULT_ERROR_MESSAGE);
    } finally {
      setBusy(undefined);
    }
  }, [signIn]);

  const signInWithGoogle = useCallback(async () => {
    setBusy('google');
    try {
      ensureGoogleConfigured();
      // Android: surfaces the "update Play Services" prompt instead of a cryptic failure; no-op on iOS.
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const response = await GoogleSignin.signIn();

      if (response.type === 'cancelled') {
        return;
      }

      const idToken = response.data.idToken;
      if (!idToken) {
        toast.error(DEFAULT_ERROR_MESSAGE);
        return;
      }

      const result = await postAuth('/api/auth/native/token', {
        provider: 'google',
        idToken,
      });

      if (result.ok) {
        await signIn((result.data as TokenResponse).token);
      } else {
        toast.error(mapError(result.errorCode));
      }
    } catch {
      toast.error(DEFAULT_ERROR_MESSAGE);
    } finally {
      setBusy(undefined);
    }
  }, [signIn]);

  const requestEmailCode = useCallback(async (rawEmail: string) => {
    const email = rawEmail.trim().toLowerCase();
    if (!email) {
      toast.error('Please enter your email address.');
      return false;
    }

    setBusy('otp-send');
    try {
      const result = await postAuth('/api/auth/native/otp', { email });
      if (!result.ok) {
        toast.error(mapError(result.errorCode));
        return false;
      }
      return true;
    } finally {
      setBusy(undefined);
    }
  }, []);

  const verifyEmailCode = useCallback(
    async (rawEmail: string, code: string) => {
      const email = rawEmail.trim().toLowerCase();
      setBusy('otp-verify');
      try {
        const result = await postAuth('/api/auth/native/token', {
          provider: 'email',
          email,
          code,
        });
        if (!result.ok) {
          toast.error(mapError(result.errorCode));
          return false;
        }
        await signIn((result.data as TokenResponse).token);
        return true;
      } catch (error) {
        // eslint-disable-next-line no-console -- surface swallowed auth errors to Sentry
        console.error('[native-auth] verifyEmailCode signIn failed:', error);
        toast.error(DEFAULT_ERROR_MESSAGE);
        return false;
      } finally {
        setBusy(undefined);
      }
    },
    [signIn]
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

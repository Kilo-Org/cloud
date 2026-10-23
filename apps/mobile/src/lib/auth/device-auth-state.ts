import { type AuthErrorMessageKey } from '@/lib/auth/auth-error-messages';

type DeviceAuthStatus = 'idle' | 'pending' | 'approved' | 'denied' | 'expired' | 'error';

/**
 * A device-auth error stored untranslated. Almost every site owns a catalog
 * key, so the screen translates it at render and a language switch re-renders
 * the banner in the new language; the one server-authored case (the 429 start
 * refusal's own body text) has no key and flows through as text.
 */
export type DeviceAuthError =
  | { kind: 'key'; key: AuthErrorMessageKey }
  | { kind: 'text'; text: string };

export function deviceAuthErrorKey(key: AuthErrorMessageKey): DeviceAuthError {
  return { kind: 'key', key };
}

export function deviceAuthErrorText(text: string): DeviceAuthError {
  return { kind: 'text', text };
}

export type DeviceAuthState = {
  status: DeviceAuthStatus;
  code: string | undefined;
  token: string | undefined;
  refreshToken: string | undefined;
  expiresIn: number | undefined;
  error: DeviceAuthError | undefined;
  verificationUrl: string | undefined;
  resumed?: boolean;
};

export function errorDeviceAuthState(
  code: string | undefined,
  error: DeviceAuthError,
  previousVerificationUrl: string | undefined
): DeviceAuthState {
  return {
    status: 'error',
    code,
    token: undefined,
    refreshToken: undefined,
    expiresIn: undefined,
    error,
    verificationUrl: previousVerificationUrl,
  };
}

export function idleDeviceAuthState(): DeviceAuthState {
  return {
    status: 'idle',
    code: undefined,
    token: undefined,
    refreshToken: undefined,
    expiresIn: undefined,
    error: undefined,
    verificationUrl: undefined,
  };
}

export function pendingDeviceAuthState(
  code: string | undefined,
  verificationUrl: string | undefined,
  resumed = false
): DeviceAuthState {
  return {
    status: 'pending',
    code,
    token: undefined,
    refreshToken: undefined,
    expiresIn: undefined,
    error: undefined,
    verificationUrl,
    resumed,
  };
}

export function approvedDeviceAuthState(params: {
  code: string;
  token: string;
  refreshToken?: string;
  expiresIn?: number;
  previousVerificationUrl?: string;
}): DeviceAuthState {
  return {
    status: 'approved',
    code: params.code,
    token: params.token,
    refreshToken: params.refreshToken,
    expiresIn: params.expiresIn,
    error: undefined,
    verificationUrl: params.previousVerificationUrl,
  };
}

export function terminalDeviceAuthState(params: {
  status: 'denied' | 'expired';
  code: string;
  error: DeviceAuthError;
  previousVerificationUrl?: string;
}): DeviceAuthState {
  return {
    status: params.status,
    code: params.code,
    token: undefined,
    refreshToken: undefined,
    expiresIn: undefined,
    error: params.error,
    verificationUrl: params.previousVerificationUrl,
  };
}

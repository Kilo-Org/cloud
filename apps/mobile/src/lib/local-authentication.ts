import type * as ExpoAuthentication from 'expo-local-authentication';

type RecoveryStatus = 'retryable' | 'unavailable' | 'terminal';
export type LocalAuthenticationFailure = Readonly<{
  status: RecoveryStatus;
  reason:
    | ExpoAuthentication.LocalAuthenticationError
    | 'missing_usage_description'
    | 'rejected'
    | 'unexpected_error';
}>;
export type LocalAuthenticationOutcome =
  | Readonly<{ status: 'authenticated' }>
  | LocalAuthenticationFailure;
type NativeAuthentication = Pick<
  typeof ExpoAuthentication,
  'authenticateAsync' | 'getEnrolledLevelAsync' | 'SecurityLevel'
>;

// Retry stays explicit. Unavailable authentication requires OS configuration; terminal failures
// require an app/device fix or sign-out. Neither recovery silently disables account protection.
const recoveryByError = new Map<string, RecoveryStatus>(
  Object.entries({
    not_enrolled: 'unavailable',
    user_cancel: 'retryable',
    app_cancel: 'retryable',
    not_available: 'unavailable',
    lockout: 'retryable',
    no_space: 'terminal',
    timeout: 'retryable',
    unable_to_process: 'retryable',
    unknown: 'retryable',
    system_cancel: 'retryable',
    user_fallback: 'retryable',
    invalid_context: 'terminal',
    passcode_not_set: 'unavailable',
    authentication_failed: 'retryable',
    missing_usage_description: 'terminal',
  } satisfies Record<
    ExpoAuthentication.LocalAuthenticationError | 'missing_usage_description',
    RecoveryStatus
  >)
);

export async function authenticateLocalAccess(
  promptMessage: string,
  adapter?: NativeAuthentication
): Promise<LocalAuthenticationOutcome> {
  try {
    const native = adapter ?? (await import('expo-local-authentication'));
    // SECRET permits a passcode-only device. Hardware/enrollment checks cannot authenticate a user
    // or identify a previous biometric enrollment. Recheck device-owner capability on every attempt.
    const level = await native.getEnrolledLevelAsync();
    if (level === native.SecurityLevel.NONE) {
      return { status: 'unavailable', reason: 'not_enrolled' };
    }
    const result = await native.authenticateAsync({ promptMessage, disableDeviceFallback: false });
    // Leave Android strength at Expo's default: Class 2-or-better plus device credentials also
    // supports Android 9/10, unlike strong-plus-credential authentication.
    if (result.success) {
      return { status: 'authenticated' };
    }
    const status = recoveryByError.get(result.error);
    return status
      ? { status, reason: result.error }
      : { status: 'terminal', reason: 'unexpected_error' };
  } catch {
    return { status: 'retryable', reason: 'rejected' };
  }
}

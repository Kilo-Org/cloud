// Maps the one-shot `?success=`/`?error=` params the Google OAuth
// connect/callback/disconnect routes append when they redirect back to the
// claw settings route into a user-facing toast. This lives in the settings
// page wrapper (ClawSettingsPage) rather than SettingsTab so the feedback still
// surfaces in the no-instance race, where settings bounces to onboarding before
// SettingsTab would ever mount.

// Known error codes get tailored copy; any other error value (e.g. a sanitized
// provider description) falls back to the generic message so failures are never
// silent.
const GOOGLE_OAUTH_GENERIC_ERROR = 'Could not connect Google Calendar. Please try again.';

const GOOGLE_OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Google Calendar connection was cancelled.',
  missing_permissions:
    'Calendar access was not granted. Please allow calendar permission and try again.',
  connection_failed: GOOGLE_OAUTH_GENERIC_ERROR,
  oauth_init_failed: 'Could not start the Google connection. Please try again.',
  missing_instance: 'Your KiloClaw instance is still starting. Try again in a moment.',
  missing_code: 'Google did not return an authorization code. Please try again.',
  invalid_state: 'The connection link expired. Please try connecting again.',
  invalid_origin: 'Could not complete the request. Please try again.',
  invalid_organization: 'Invalid organization for this connection.',
  unauthorized: 'You are not authorized to complete this connection.',
  disconnect_failed: 'Could not disconnect Google Calendar. Please try again.',
  method_not_allowed: 'That request could not be completed. Please try again.',
};

export type GoogleOAuthFeedback = { kind: 'success' | 'error'; message: string };

/**
 * Resolve the toast to show for the Google OAuth redirect params, or null when
 * the params aren't ours. Only `google_connected`/`google_disconnected` count
 * as success; any non-empty `error` is treated as a Google failure (only these
 * routes append `?error=` to the settings route).
 */
export function resolveGoogleOAuthFeedback(
  success: string | null,
  error: string | null
): GoogleOAuthFeedback | null {
  if (success === 'google_connected') {
    return { kind: 'success', message: 'Google Calendar connected' };
  }
  if (success === 'google_disconnected') {
    return { kind: 'success', message: 'Google Calendar disconnected' };
  }
  if (error) {
    return {
      kind: 'error',
      message: GOOGLE_OAUTH_ERROR_MESSAGES[error] ?? GOOGLE_OAUTH_GENERIC_ERROR,
    };
  }
  return null;
}

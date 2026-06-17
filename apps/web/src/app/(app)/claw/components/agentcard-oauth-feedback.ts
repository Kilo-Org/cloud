// Maps the one-shot `?success=`/`?error=` params the AgentCard OAuth
// connect/callback/disconnect routes append when they redirect back to the claw
// settings route into a user-facing toast. Mirrors google-oauth-feedback.ts.
//
// AgentCard and Google share several generic error codes (oauth_init_failed,
// missing_instance, …), so the routes also append `provider=agentcard`; the
// settings page uses that marker to pick this resolver over the Google one.

const AGENTCARD_OAUTH_GENERIC_ERROR = 'Could not connect Agentcard. Please try again.';

const AGENTCARD_OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Agentcard connection was cancelled.',
  connection_failed: AGENTCARD_OAUTH_GENERIC_ERROR,
  oauth_init_failed: 'Could not start the Agentcard connection. Please try again.',
  oauth_error: AGENTCARD_OAUTH_GENERIC_ERROR,
  missing_instance: 'Your KiloClaw instance is still starting. Try again in a moment.',
  missing_code: 'Agentcard did not return an authorization code. Please try again.',
  invalid_state: 'The connection link expired. Please try connecting again.',
  invalid_origin: 'Could not complete the request. Please try again.',
  invalid_organization: 'Invalid organization for this connection.',
  unauthorized: 'You are not authorized to complete this connection.',
  // The grant succeeded but pushing the token to the agent's worker did not.
  agentcard_connect_incomplete:
    'Agentcard connected, but we could not finish setting it up on your agent. Please try reconnecting.',
  disconnect_failed: 'Could not disconnect Agentcard. Please try again.',
  method_not_allowed: 'That request could not be completed. Please try again.',
};

export type AgentCardOAuthFeedback = { kind: 'success' | 'error'; message: string };

/**
 * Resolve the toast to show for the AgentCard OAuth redirect params. Only
 * `agentcard_connected`/`agentcard_disconnected` count as success; any non-empty
 * `error` falls back to the generic message so failures are never silent.
 */
export function resolveAgentCardOAuthFeedback(
  success: string | null,
  error: string | null
): AgentCardOAuthFeedback | null {
  if (success === 'agentcard_connected') {
    return { kind: 'success', message: 'Agentcard connected' };
  }
  if (success === 'agentcard_disconnected') {
    return { kind: 'success', message: 'Agentcard disconnected' };
  }
  if (error) {
    return {
      kind: 'error',
      message: AGENTCARD_OAUTH_ERROR_MESSAGES[error] ?? AGENTCARD_OAUTH_GENERIC_ERROR,
    };
  }
  return null;
}

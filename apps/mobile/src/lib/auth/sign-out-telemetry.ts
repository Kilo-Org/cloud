import { captureTelemetry } from '@/lib/telemetry/error-sink';

/**
 * The durable, branch-named record of an auth transition.
 *
 * Committed console logging is forbidden, so this is the transport-neutral
 * sink the auth paths write through: the installed telemetry sink decides
 * where a row lands, and every row names the cause and the branch that fired
 * so a future report can be answered from data. Never a token, a token
 * prefix, or a refresh token — only a branch, a cause, and storage-key names
 * (see {@link AuthSignOutCause} / {@link AuthBranch}).
 */

export type AuthSignOutCause = 'user' | 'session_ended' | 'credentials_unreadable';

export type AuthBranch = 'explicit' | 'refresh_401' | 'refresh_token_unreadable';

/**
 * Record the branch an auth transition took. `keyNames` are storage-key names
 * only (`auth-token`, `auth-refresh-token`, `auth-token-expires-at`) and are
 * reported only when a read was attempted, so an unreadable credential read
 * says which members were present without exposing a value.
 */
export function reportAuthBranch(input: {
  cause: AuthSignOutCause;
  branch: AuthBranch;
  keyNames?: readonly string[];
}): void {
  captureTelemetry({
    level: 'warning',
    message: 'auth branch',
    tags: {
      'auth.cause': input.cause,
      'auth.branch': input.branch,
      ...(input.keyNames?.length ? { 'auth.keys': input.keyNames.join(',') } : {}),
    },
  });
}

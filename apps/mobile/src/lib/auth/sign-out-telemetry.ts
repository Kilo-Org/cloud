import { addTelemetryBreadcrumb, captureTelemetry } from '@/lib/telemetry/error-sink';

/**
 * The durable, branch-named record of an auth transition.
 *
 * Committed console logging is forbidden, so this is the transport-neutral
 * sink the auth paths write through: the installed telemetry sink decides
 * where a row lands, and every row names the cause and the branch that fired
 * so a future report can be answered from data. Never a token, a token
 * prefix, or a refresh token — only a branch and a cause (see
 * {@link AuthSignOutCause} / {@link AuthBranch}).
 */

export type AuthSignOutCause = 'user' | 'session_ended' | 'session_unrenewable';

export type AuthBranch = 'explicit' | 'refresh_401' | 'refresh_token_absent';

/**
 * The branch each sign-out cause reports: the person signed out, the server
 * refused the credential set, or the set can never rotate again.
 */
export const AUTH_BRANCH_BY_CAUSE = {
  user: 'explicit',
  session_ended: 'refresh_401',
  session_unrenewable: 'refresh_token_absent',
} satisfies Readonly<Record<AuthSignOutCause, AuthBranch>>;

/**
 * Record the branch an auth transition took. Never a value from the credential
 * store: only a branch and a cause.
 *
 * A sign-out the user asked for is expected, so it is a breadcrumb for the
 * next event, not an event of its own. Every other branch is one issue per
 * cause and branch: without the fingerprint Sentry groups the event by its
 * stack and titles it with the sink's frame name.
 */
export function reportAuthBranch(input: { cause: AuthSignOutCause }): void {
  const branch = AUTH_BRANCH_BY_CAUSE[input.cause];
  const tags = {
    'auth.cause': input.cause,
    'auth.branch': branch,
  };
  if (input.cause === 'user') {
    addTelemetryBreadcrumb({
      category: 'auth',
      message: 'auth branch',
      level: 'warning',
      data: tags,
    });
    return;
  }
  captureTelemetry({
    level: 'warning',
    error: new Error(`Auth branch: ${input.cause} (${branch})`),
    tags,
    fingerprint: ['auth-branch', input.cause, branch],
  });
}

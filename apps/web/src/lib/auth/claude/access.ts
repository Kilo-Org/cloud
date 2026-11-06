/**
 * PostHog release toggle for "Sign in with Claude". It is a global launch
 * switch, not a per-person rollout: the sign-in page has no person yet, so the
 * server evaluates it without one and the sign-in page reads the same flag.
 */
export const CLAUDE_SIGN_IN_FLAG = 'sign-in-with-claude';

/** `providers` without Claude unless Sign in with Claude is launched. */
export function withLaunchedClaudeSignIn<T extends string>(
  providers: readonly T[],
  claudeSignInEnabled: boolean
): T[] {
  return claudeSignInEnabled ? [...providers] : providers.filter(provider => provider !== 'claude');
}

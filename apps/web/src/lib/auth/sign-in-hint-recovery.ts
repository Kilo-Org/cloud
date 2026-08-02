import type { SignInHint } from '@/hooks/useSignInHint';

type SsoHintFields = Pick<SignInHint, 'lastAuthMethod' | 'orgId'>;

/**
 * Decides whether a stored sign-in hint must be discarded after a failed sign-in.
 *
 * An SSO hint is the only hint that pins the browser to a specific WorkOS
 * organization id, and the returning-user screen intentionally offers no
 * alternative method for it (other methods genuinely cannot work for a domain
 * where SSO is required). That combination makes a stale SSO hint unrecoverable:
 * if the organization stops resolving - deleted in WorkOS, its connection
 * detached, or `organizations.sso_domain` cleared - the redirect fails, the user
 * is bounced back here with an `error`, and the same failing button is rendered
 * again. Every retry reproduces the failure.
 *
 * Discarding the hint returns the user to the email prompt, which re-runs the
 * server-side `/api/sso/organizations` lookup and resolves the organization that
 * is live right now.
 *
 * Any error is treated as disqualifying rather than an allowlist of codes. No
 * error code means "the SSO redirect succeeded", the set of codes that can land
 * on the sign-in page is large and drifts (NextAuth internals plus our own), and
 * the outcomes are wildly asymmetric: a false positive costs one retyped email
 * address, while a missed case leaves an account permanently unable to sign in.
 */
export function shouldDiscardSsoHintOnError(
  hint: SsoHintFields | null | undefined,
  error: string | null | undefined
): boolean {
  if (!error) {
    return false;
  }
  return hint?.lastAuthMethod === 'workos' && !!hint.orgId;
}

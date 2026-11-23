/**
 * The two refusals `validateUserAuthorization` can answer with are different
 * promises, so the client must not treat them as one.
 *
 * - `account_blocked` (R1) is a property of one account. Support can lift the
 *   block, so a client may offer the read again: the same request can succeed
 *   once the account is unblocked.
 * - `email_domain_blocked` (R0) is a property of the email domain, matched
 *   against an admin-managed blacklist (`blacklisted_domains`). Nothing the
 *   person does — retry, sign out, sign back in — changes it, so a client must
 *   not offer a retry that can never succeed.
 *
 * Both keep access denied, and both keep the same HTTP/tRPC shape; this value
 * only chooses the explanation and the actions the client shows. It travels as
 * `data.accountBlockedReason` next to `data.accountBlocked` (see
 * `packages/web-shared/src/lib/trpc/transport.ts`), which stays `true` for both.
 */
export const ACCOUNT_BLOCKED_REFUSAL_REASONS = ['account_blocked', 'email_domain_blocked'] as const;

export type AccountBlockedRefusalReason = (typeof ACCOUNT_BLOCKED_REFUSAL_REASONS)[number];

/**
 * The refusal when `value` is one of them, else `null`. `find` over the tuple
 * rather than a `Set` plus a cast: the element type is the union itself, so the
 * answer is typed without asserting it.
 */
export function accountBlockedRefusalReason(value: unknown): AccountBlockedRefusalReason | null {
  if (typeof value !== 'string') return null;
  return ACCOUNT_BLOCKED_REFUSAL_REASONS.find(reason => reason === value) ?? null;
}

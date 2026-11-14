import type { user_auth_provider } from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { getDeliveredEmailAddress } from '@kilocode/web-shared/lib/email-address';

/**
 * Provider types whose every `user_auth_provider` writer stores an address the
 * credential verified: Google (the browser profile asserts `email_verified`,
 * the native token verifier refuses without it), Anaconda (its profile parser
 * requires `email_verified: true`), and email (a consumed magic link or code
 * delivered to that address).
 *
 * Apple is excluded because the browser path stores the ID token's address
 * without checking `email_verified`, which Apple leaves false for some Work &
 * School accounts. WorkOS is excluded because directory sync provisions a new
 * address without a domain check, so its rows can carry an address nobody
 * verified.
 */
const VERIFIED_ADDRESS_PROVIDERS: Partial<Record<AuthProviderId, true>> = {
  google: true,
  anaconda: true,
  email: true,
};

/**
 * Whether the account holds a sign-in method that verified its primary
 * address. An explicitly linked method verifies only its own address, so a row
 * for a different address does not count. The comparison ignores case only:
 * `normalizeEmail` strips `+` aliases, which can name a different mailbox.
 *
 * An empty `providers` list is false. Callers that also accept an account with
 * no provider rows say so themselves.
 */
export function hasVerifiedPrimaryAddress(
  primaryEmail: string,
  providers: readonly Pick<typeof user_auth_provider.$inferSelect, 'provider' | 'email'>[]
): boolean {
  const primary = getDeliveredEmailAddress(primaryEmail);
  return providers.some(
    p =>
      VERIFIED_ADDRESS_PROVIDERS[p.provider] === true &&
      getDeliveredEmailAddress(p.email) === primary
  );
}

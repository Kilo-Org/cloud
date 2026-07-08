import type { NextRequest } from 'next/server';
import { checkRateLimit } from '@vercel/firewall';
import { createHmac } from 'node:crypto';
import { findUserByEmail, getWorkOSOrganization } from '@/lib/user';
import { validateMagicLinkSignupEmail } from '@/lib/schemas/email';
import { isEmailBlacklistedByDomainAsync, isBlockedTLD } from '@/lib/user/server';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { resolveSsoAuthorityForDomain } from '@/lib/organizations/organization-sso-policy';
import { getLowerDomainFromEmail } from '@/lib/utils';

const MAGIC_LINK_EMAIL_RATE_LIMIT_ID = 'magic-link-email';

function getMagicLinkEmailRateLimitKey(email: string): string {
  const emailHash = createHmac('sha256', NEXTAUTH_SECRET)
    .update(email.trim().toLowerCase())
    .digest('base64url');
  return `magic-link-email:${emailHash}`;
}

export type EmailSignInEligibility =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Checks whether an email is eligible for email sign-in: not rate limited,
 * not blacklisted, not SSO-enforced for its domain, and (for new users) not
 * blocked by TLD or signup email rules.
 *
 * For NEW users (signup), enforces:
 * - Email must be lowercase
 * - Email cannot contain a + character
 *
 * For EXISTING users (sign-in), these restrictions are NOT enforced.
 */
export async function checkEmailSignInEligibility(
  email: string,
  request: NextRequest
): Promise<EmailSignInEligibility> {
  const { rateLimited } = await checkRateLimit(MAGIC_LINK_EMAIL_RATE_LIMIT_ID, {
    request,
    rateLimitKey: getMagicLinkEmailRateLimitKey(email),
  });

  if (rateLimited) {
    return {
      ok: false,
      status: 429,
      body: { success: false, error: 'Rate limit exceeded. Please try again later.' },
    };
  }

  if (await isEmailBlacklistedByDomainAsync(email)) {
    return { ok: false, status: 403, body: { success: false, error: 'BLOCKED' } };
  }

  // Check if this is an existing user (sign-in) or new user (signup)
  const existingUser = await findUserByEmail(email);
  const primaryEmail = existingUser?.google_user_email ?? email;
  const primaryDomain = getLowerDomainFromEmail(primaryEmail);
  if (primaryDomain) {
    const ssoAuthority = await resolveSsoAuthorityForDomain(primaryDomain);
    if (ssoAuthority.status === 'misconfigured') {
      return {
        ok: false,
        status: 503,
        body: { success: false, error: 'SSO configuration error. Contact your administrator.' },
      };
    }
    if (ssoAuthority.status === 'required') {
      const workosOrganization = await getWorkOSOrganization(primaryDomain);
      if (!workosOrganization) {
        return {
          ok: false,
          status: 503,
          body: { success: false, error: 'SSO configuration error. Contact your administrator.' },
        };
      }

      return {
        ok: false,
        status: 403,
        body: {
          success: false,
          error: 'Sign in with your organization SSO provider.',
          ssoOrganizationId: workosOrganization.id,
        },
      };
    }
  }

  // For new users, enforce stricter email validation and TLD blocking
  if (!existingUser) {
    if (isBlockedTLD(email)) {
      return { ok: false, status: 403, body: { success: false, error: 'BLOCKED' } };
    }
    const signupValidation = validateMagicLinkSignupEmail(email);
    if (!signupValidation.valid) {
      return {
        ok: false,
        status: 400,
        body: { success: false, error: signupValidation.error },
      };
    }
  }

  return { ok: true };
}

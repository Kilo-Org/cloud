import type { NextRequest } from 'next/server';
import { checkRateLimit } from '@vercel/firewall';
import { createHmac } from 'node:crypto';
import { findUserByNormalizedEmail, getWorkOSOrganization } from '@/lib/user';
import { validateMagicLinkSignupEmail } from '@/lib/schemas/email';
import { isEmailBlacklistedByDomainAsync, isBlockedTLD } from '@/lib/user/server';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { resolveSsoAuthorityForDomain } from '@/lib/organizations/organization-sso-policy';
import { getLowerDomainFromEmail, normalizeEmail } from '@/lib/utils';
import type { AuthErrorType } from '@/lib/auth/constants';

const MAGIC_LINK_EMAIL_RATE_LIMIT_ID = 'magic-link-email';

function getMagicLinkEmailRateLimitKey(email: string): string {
  const emailHash = createHmac('sha256', NEXTAUTH_SECRET)
    .update(normalizeEmail(email))
    .digest('base64url');
  return `magic-link-email:${emailHash}`;
}

export type DomainSignInEligibility =
  | { ok: true; existingUser: boolean }
  | {
      ok: false;
      status: number;
      errorCode: Extract<AuthErrorType, 'BLOCKED' | 'SSO_ERROR'>;
      ssoOrganizationId?: string;
    };

/**
 * Checks whether an email's domain is allowed to sign in at all: not
 * blacklisted, not a blocked TLD (new users only), and not subject to
 * mandatory SSO. This is the shared core enforced for EVERY sign-in path
 * (email code, magic link, and native Apple/Google) — mirrors the checks
 * inline in the NextAuth `signIn` callback (lib/user/server.ts) so that no
 * provider can bypass forced SSO or the domain blacklist.
 *
 * Does NOT rate limit and does NOT apply magic-link-specific signup email
 * rules (lowercase/no-plus) — those are the caller's concern.
 */
export async function checkDomainSignInEligibility(
  email: string
): Promise<DomainSignInEligibility> {
  if (await isEmailBlacklistedByDomainAsync(email)) {
    return { ok: false, status: 403, errorCode: 'BLOCKED' };
  }

  const existingUser = await findUserByNormalizedEmail(email);

  // Block new signups from blocked TLDs (existing users can still sign in)
  if (!existingUser && isBlockedTLD(email)) {
    return { ok: false, status: 403, errorCode: 'BLOCKED' };
  }

  const domainToCheck = getLowerDomainFromEmail(existingUser?.google_user_email ?? email);

  // we don't need to check gmail domains for SSO for now.
  // This is mostly an optimization so we don't hit the DB on every gmail login since they defacto aren't using SSO
  if (domainToCheck && domainToCheck !== 'gmail.com') {
    const ssoAuthority = await resolveSsoAuthorityForDomain(domainToCheck);
    if (ssoAuthority.status === 'misconfigured') {
      return { ok: false, status: 503, errorCode: 'SSO_ERROR' };
    }
    if (ssoAuthority.status === 'required') {
      const workosOrganization = await getWorkOSOrganization(domainToCheck);
      if (!workosOrganization) {
        return { ok: false, status: 503, errorCode: 'SSO_ERROR' };
      }
      return {
        ok: false,
        status: 403,
        errorCode: 'SSO_ERROR',
        ssoOrganizationId: workosOrganization.id,
      };
    }
  }

  return { ok: true, existingUser: !!existingUser };
}

export type EmailSignInEligibility =
  | { ok: true }
  | {
      ok: false;
      status: number;
      errorCode: 'BLOCKED' | 'INVALID_EMAIL' | 'SIGNUP-RATE-LIMITED' | 'SSO_ERROR';
      body: Record<string, unknown>;
    };

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
      errorCode: 'SIGNUP-RATE-LIMITED',
      body: { success: false, error: 'Rate limit exceeded. Please try again later.' },
    };
  }

  const domainEligibility = await checkDomainSignInEligibility(email);
  if (!domainEligibility.ok) {
    if (domainEligibility.errorCode === 'BLOCKED') {
      return {
        ok: false,
        status: domainEligibility.status,
        errorCode: 'BLOCKED',
        body: { success: false, error: 'BLOCKED' },
      };
    }
    // SSO_ERROR
    if (domainEligibility.status === 503) {
      return {
        ok: false,
        status: 503,
        errorCode: 'SSO_ERROR',
        body: { success: false, error: 'SSO configuration error. Contact your administrator.' },
      };
    }
    return {
      ok: false,
      status: domainEligibility.status,
      errorCode: 'SSO_ERROR',
      body: {
        success: false,
        error: 'Sign in with your organization SSO provider.',
        ssoOrganizationId: domainEligibility.ssoOrganizationId,
      },
    };
  }

  // For new users, enforce stricter email validation
  if (!domainEligibility.existingUser) {
    const signupValidation = validateMagicLinkSignupEmail(email);
    if (!signupValidation.valid) {
      return {
        ok: false,
        status: 400,
        errorCode: 'INVALID_EMAIL',
        body: { success: false, error: signupValidation.error },
      };
    }
  }

  return { ok: true };
}

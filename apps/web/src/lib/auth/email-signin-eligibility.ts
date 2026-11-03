import type { NextRequest } from 'next/server';
import { checkRateLimit } from '@vercel/firewall';
import { captureMessage } from '@sentry/nextjs';
import { createHmac } from 'node:crypto';
import { findUserByNormalizedEmail, getWorkOSOrganization } from '@/lib/user';
import { validateMagicLinkSignupEmail } from '@/lib/schemas/email';
import { isEmailSignupDisabled } from '@/lib/auth/email-signup-switch';
import {
  isEmailBlacklistedByDomainAsync,
  isBlockedTLD,
} from '@kilocode/web-shared/lib/user/server';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { getLowerDomainFromEmail, normalizeEmail } from '@kilocode/web-shared/lib/email-address';
import type { AuthErrorType } from '@kilocode/web-shared/lib/auth/constants';

const MAGIC_LINK_EMAIL_RATE_LIMIT_ID = 'magic-link-email';
const SIGN_IN_CODE_EMAIL_IP_RATE_LIMIT_ID = 'sign-in-code-email-ip';

/**
 * Vercel Firewall rate limits that apply to sign-in code email volume. Each
 * rule lives in the project's firewall configuration; a rule that is not
 * configured is skipped and the gap is reported to Sentry at most once a
 * minute.
 *
 * - `magic-link-email` counts sends per normalized address.
 * - `sign-in-code-email-ip` counts sends per caller address.
 */
function getMagicLinkEmailRateLimitKey(email: string): string {
  const emailHash = createHmac('sha256', NEXTAUTH_SECRET)
    .update(normalizeEmail(email))
    .digest('base64url');
  return `magic-link-email:${emailHash}`;
}

/**
 * The caller address the firewall rule counts against. `x-vercel-forwarded-for`
 * is the header Vercel's edge sets for the request's source address, so it is
 * read first; `clientIpFromHeaders` in
 * packages/web-shared/src/lib/admin/admin-access-log.ts reads the same header
 * as its fallback. `x-real-ip` covers requests that arrive without the edge
 * header, and `unknown` keeps the bucket key non-empty.
 */
function clientIpAddress(request: NextRequest): string {
  const forwarded = request.headers.get('x-vercel-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() || 'unknown';
  }
  return request.headers.get('x-real-ip') || 'unknown';
}

const missingRuleReportedAt: Record<string, number> = {};
const MISSING_RULE_REPORT_INTERVAL_MS = 60_000;

/**
 * One report a minute is enough to raise the alarm for a rule that is missing
 * from the project's firewall configuration; reporting per request would flood
 * Sentry.
 */
function reportMissingRule(ruleId: string): void {
  const now = Date.now();
  if (now - (missingRuleReportedAt[ruleId] ?? 0) >= MISSING_RULE_REPORT_INTERVAL_MS) {
    missingRuleReportedAt[ruleId] = now;
    captureMessage(`Firewall rate limit '${ruleId}' is not configured`, {
      level: 'error',
      tags: { source: 'email_signin_eligibility' },
    });
  }
}

/**
 * Applies the per-address and per-caller firewall rules and reports whether a
 * count is exhausted. A rule that is not configured is skipped.
 * Runs before the eligibility rules: these refusals cost nothing downstream.
 */
async function isSendBudgetExhausted(email: string, request: NextRequest): Promise<boolean> {
  const checks = [
    {
      id: MAGIC_LINK_EMAIL_RATE_LIMIT_ID,
      key: getMagicLinkEmailRateLimitKey(email),
    },
    {
      id: SIGN_IN_CODE_EMAIL_IP_RATE_LIMIT_ID,
      key: `${SIGN_IN_CODE_EMAIL_IP_RATE_LIMIT_ID}:${clientIpAddress(request)}`,
    },
  ] as const;

  for (const check of checks) {
    const { rateLimited, error } = await checkRateLimit(check.id, {
      request,
      rateLimitKey: check.key,
    });
    if (error === 'not-found') {
      reportMissingRule(check.id);
      continue;
    }
    if (rateLimited) {
      return true;
    }
  }
  return false;
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
 * mandatory SSO. This is the shared core enforced for EVERY sign-in path —
 * mirrors the checks inline in the NextAuth `signIn` callback
 * (lib/user/next-auth-options.ts) so that no provider can bypass forced SSO or
 * the domain blacklist.
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
  if (!existingUser && (await isBlockedTLD(email))) {
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
      errorCode:
        | 'BLOCKED'
        | 'EMAIL-SIGNUP-DISABLED'
        | 'INVALID_EMAIL'
        | 'SIGNUP-RATE-LIMITED'
        | 'SSO_ERROR';
      body: Record<string, unknown>;
    };

/**
 * Applies the static rules for a new account's magic-link option without
 * creating a token, sending mail, or consuming a rate-limit allowance.
 */
export async function isNewAccountEligibleForMagicLink(email: string): Promise<boolean> {
  if (isEmailSignupDisabled() || !validateMagicLinkSignupEmail(email).valid) {
    return false;
  }

  if (await isEmailBlacklistedByDomainAsync(email)) {
    return false;
  }

  return !(await isBlockedTLD(email));
}

/**
 * Checks whether an email is eligible for email sign-in: not rate limited,
 * not blacklisted, not SSO-enforced for its domain, and (for new users) not
 * blocked by TLD or signup email rules.
 *
 * For NEW users (signup), enforces:
 * - Email signup is enabled (EMAIL_SIGNUPS_ENABLED)
 * - Email must be lowercase
 * - Email cannot contain a + character
 *
 * For EXISTING users (sign-in), these restrictions are NOT enforced.
 */
export async function checkEmailSignInEligibility(
  email: string,
  request: NextRequest
): Promise<EmailSignInEligibility> {
  if (await isSendBudgetExhausted(email, request)) {
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

  if (!domainEligibility.existingUser) {
    if (isEmailSignupDisabled()) {
      return {
        ok: false,
        status: 403,
        errorCode: 'EMAIL-SIGNUP-DISABLED',
        body: { success: false, error: 'EMAIL-SIGNUP-DISABLED' },
      };
    }

    // For new users, enforce stricter email validation
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

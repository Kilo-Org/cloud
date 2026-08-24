import { NextResponse } from 'next/server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { sentryLogger } from '@/lib/utils.server';
import { verifyTurnstileJWT } from '@/lib/auth/verify-turnstile-jwt';
import { getLowerDomainFromEmail, normalizeEmail } from '@/lib/utils';
import { getAllUserProviders, getWorkOSOrganization } from '@/lib/user';
import { resolveSsoAuthorityForDomain } from '@/lib/organizations/organization-sso-policy';
import {
  SignInDiscoveryRequestSchema,
  SignInDiscoveryResponseSchema,
  type SignInDiscoveryResponse,
} from '@/lib/schemas/sso-organizations';
import { checkRateLimit } from '@vercel/firewall';
import { createHmac } from 'node:crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { isNewAccountEligibleForMagicLink } from '@/lib/auth/email-signin-eligibility';
import { ProdNonSSOAuthProviders } from '@/lib/auth/provider-metadata';

const warnInSentry = sentryLogger('sso-organizations', 'warning');
const DISCOVERY_IP_RATE_LIMIT_ID = 'sign-in-discovery-ip';
const DISCOVERY_EMAIL_RATE_LIMIT_ID = 'sign-in-discovery-email';

export function discoveryEmailRateLimitKey(email: string): string {
  return createHmac('sha256', NEXTAUTH_SECRET).update(normalizeEmail(email)).digest('base64url');
}

function discoveryResponse(response: SignInDiscoveryResponse, init?: ResponseInit): NextResponse {
  return NextResponse.json(SignInDiscoveryResponseSchema.parse(response), init);
}

/**
 * Checks if an email domain has SSO configured and returns the WorkOS organization ID.
 * Also checks if the user has an existing account and returns all their auth providers
 * for provider selection UI (if they have multiple options).
 *
 * IMPORTANT: This API determines routing/UI options only. The email provided here is NOT
 * used for authentication. The actual login email comes from the OAuth provider response.
 *
 * We ask for email first to route users correctly:
 * - SSO domains (e.g., company.com) → WorkOS Google (enterprise)
 * - Personal domains (e.g., gmail.com) → Personal Google OAuth
 *
 * @method POST
 */
export async function POST(request: Request): Promise<NextResponse> {
  let userProviders: string[] | null = null;

  try {
    const turnstileResult = await verifyTurnstileJWT('sso-organizations');
    if (!turnstileResult.success) {
      return turnstileResult.response;
    }

    const body = await request.json().catch(() => undefined);
    const parsedRequest = SignInDiscoveryRequestSchema.safeParse(body);
    if (!parsedRequest.success) {
      return NextResponse.json({ error: 'Invalid email address.' }, { status: 400 });
    }
    const { email } = parsedRequest.data;

    const [ipLimit, emailLimit] = await Promise.all([
      checkRateLimit(DISCOVERY_IP_RATE_LIMIT_ID, { request }),
      checkRateLimit(DISCOVERY_EMAIL_RATE_LIMIT_ID, {
        request,
        rateLimitKey: discoveryEmailRateLimitKey(email),
      }),
    ]);
    if (ipLimit.rateLimited || emailLimit.rateLimited) {
      return NextResponse.json({ error: 'Please try again later.' }, { status: 429 });
    }
    if (ipLimit.error || emailLimit.error) {
      captureMessage('Sign-in discovery rate limit unavailable', {
        level: 'error',
        tags: { source: 'sso-organizations-rate-limit' },
        extra: {
          ipLimiterError: ipLimit.error ?? null,
          emailLimiterError: emailLimit.error ?? null,
        },
      });
      return NextResponse.json({ error: 'Please try again later.' }, { status: 503 });
    }

    const providerLookup = await getAllUserProviders(email);
    if (providerLookup.kind === 'ambiguous') {
      return NextResponse.json(
        { error: 'Unable to find sign-in methods. Please try again.' },
        { status: 503 }
      );
    }
    if (providerLookup.kind === 'found') {
      const userProviderInfo = providerLookup.user;
      userProviders = userProviderInfo.providers;

      // User already has WorkOS linked → enforce SSO via their linked domain
      if (userProviderInfo.workosHostedDomain) {
        const ssoResponse = await tryGetSSOResponse(userProviderInfo.workosHostedDomain);
        if (ssoResponse) return ssoResponse;

        warnInSentry('User has workos provider but no active SSO authority', {
          extra: { workosHostedDomain: userProviderInfo.workosHostedDomain },
        });
      }

      // Check if PRIMARY email domain has SSO configured → force WorkOS
      // This prevents SSO bypass via linked personal accounts (gmail, etc.)
      const primaryEmailDomain = getLowerDomainFromEmail(userProviderInfo.primaryEmail);
      if (primaryEmailDomain) {
        const ssoResponse = await tryGetSSOResponse(primaryEmailDomain);
        if (ssoResponse) {
          return ssoResponse;
        }
      }

      // Return the matched account even when its methods are unsupported. The
      // client presents a recoverable error rather than broadening to signup.
      return discoveryResponse({ kind: 'existing', providers: userProviderInfo.providers });
    }

    // ─── New User Flow ────────────────────────────────────────────────────
    // Check if their email domain has SSO configured
    const domain = getLowerDomainFromEmail(email);
    if (domain) {
      const ssoResponse = await tryGetSSOResponse(domain);
      if (ssoResponse) {
        return ssoResponse;
      }
    }

    // No organization or provider found → new user signup flow. Resolve the
    // email option on the server so account-creation rules remain authoritative
    // without spending the magic-link rate-limit allowance during discovery.
    const providers = [
      ...((await isNewAccountEligibleForMagicLink(email))
        ? ProdNonSSOAuthProviders
        : ProdNonSSOAuthProviders.filter(provider => provider !== 'email')),
    ];
    return discoveryResponse({ kind: 'new', providers });
  } catch (err: unknown) {
    warnInSentry('sso error');
    captureException(err, {
      tags: { source: 'sso/organizations' },
      extra: { providerCount: userProviders?.length ?? 0 },
    });
    return NextResponse.json(
      { error: 'Unable to find sign-in methods. Please try again.' },
      { status: 503 }
    );
  }
}

/**
 * If the domain has SSO configured, returns a WorkOS response.
 * Returns null if no SSO is configured or if WorkOS organization lookup fails.
 */
async function tryGetSSOResponse(domain: string): Promise<NextResponse | null> {
  const authority = await resolveSsoAuthorityForDomain(domain);
  if (authority.status === 'not_required') {
    return null;
  }
  if (authority.status === 'misconfigured') {
    warnInSentry('Local SSO authority is misconfigured', {
      extra: { domain, reason: authority.reason },
    });
    return NextResponse.json(
      { error: 'Unable to find sign-in methods. Please try again.' },
      { status: 503 }
    );
  }

  const organization = await getWorkOSOrganization(domain);
  if (organization) {
    return discoveryResponse({ kind: 'sso', organizationId: organization.id });
  }

  // DB says SSO exists but WorkOS doesn't have it - this is a config error
  warnInSentry('Local organization has SSO but WorkOS organization not found', {
    extra: { domain, localOrgId: authority.sourceOrganizationId },
  });
  return NextResponse.json(
    { error: 'Unable to find sign-in methods. Please try again.' },
    { status: 503 }
  );
}

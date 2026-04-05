import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { sentryLogger } from '@/lib/utils.server';
import { verifyTurnstileJWT } from '@/lib/auth/verify-turnstile-jwt';
import { getLowerDomainFromEmail } from '@/lib/utils';
import { getAllUserProviders, getWorkOSOrganization } from '@/lib/user';
import { doesOrgWithSSODomainExist } from '@/lib/organizations/organizations';
import type { SSOOrganizationsResponse } from '@/lib/schemas/sso-organizations';

const warnInSentry = sentryLogger('sso-organizations', 'warning');

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

    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      const response: SSOOrganizationsResponse = {
        providers: [],
        newUser: true,
      };
      return NextResponse.json(response, { status: 200 });
    }

    const userProviderInfo = await getAllUserProviders(email);
    if (userProviderInfo) {
      userProviders = userProviderInfo.providers;

      // User already has WorkOS linked → enforce SSO via their linked domain
      if (userProviderInfo.workosHostedDomain) {
        const organization = await getWorkOSOrganization(userProviderInfo.workosHostedDomain);
        if (organization) {
          const response: SSOOrganizationsResponse = {
            providers: ['workos'],
            organizationId: organization.id,
            newUser: false,
          };
          return NextResponse.json(response);
        }

        warnInSentry('User has workos provider but could not find organization', {
          extra: { email, workosHostedDomain: userProviderInfo.workosHostedDomain },
        });
      }

      // Check if PRIMARY email domain has SSO configured → force WorkOS
      // This prevents SSO bypass via linked personal accounts (gmail, etc.)
      const primaryEmailDomain = getLowerDomainFromEmail(userProviderInfo.primaryEmail);
      if (primaryEmailDomain) {
        const ssoResponse = await tryGetSSOResponse(primaryEmailDomain, {
          loginEmail: email,
          primaryEmail: userProviderInfo.primaryEmail,
        });
        if (ssoResponse) {
          return ssoResponse;
        }
      }

      // No SSO requirement → return all available providers for user to choose
      if (userProviderInfo.providers.length > 0) {
        const response: SSOOrganizationsResponse = {
          providers: userProviderInfo.providers,
          newUser: false,
        };
        return NextResponse.json(response);
      }
    }

    // ─── New User Flow ────────────────────────────────────────────────────
    // Check if their email domain has SSO configured
    const domain = getLowerDomainFromEmail(email);
    if (domain) {
      const ssoResponse = await tryGetSSOResponse(domain, { email });
      if (ssoResponse) {
        return ssoResponse;
      }
    }

    // No organization or provider found → new user signup flow
    const response: SSOOrganizationsResponse = {
      providers: [],
      newUser: true,
    };
    return NextResponse.json(response);
  } catch (err: unknown) {
    warnInSentry('sso error', { extra: { err } });
    captureException(err, {
      tags: { source: 'sso/organizations' },
      extra: { userProviders },
    });
    // Return newUser: true for graceful degradation to "new user" flow
    // Errors are logged to Sentry above for debugging
    const response: SSOOrganizationsResponse = {
      providers: [],
      newUser: true,
    };
    return NextResponse.json(response);
  }
}

/**
 * If the domain has SSO configured, returns a WorkOS response.
 * Returns null if no SSO is configured or if WorkOS organization lookup fails.
 */
async function tryGetSSOResponse(
  domain: string,
  warningContext: Record<string, unknown>
): Promise<NextResponse | null> {
  const localOrgId = await doesOrgWithSSODomainExist(domain);
  if (!localOrgId) {
    return null;
  }

  const organization = await getWorkOSOrganization(domain);
  if (organization) {
    const response: SSOOrganizationsResponse = {
      providers: ['workos'],
      organizationId: organization.id,
      newUser: false,
    };
    return NextResponse.json(response);
  }

  // DB says SSO exists but WorkOS doesn't have it - this is a config error
  warnInSentry('Local organization has SSO but WorkOS organization not found', {
    extra: { ...warningContext, domain, localOrgId },
  });
  return null;
}

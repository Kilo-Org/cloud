import 'server-only';

import { captureException } from '@sentry/nextjs';
import { eq } from 'drizzle-orm';
import { organizations, type User } from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { AUTH_PROVIDER_DISPLAY_NAMES } from '@kilocode/web-shared/lib/auth/constants';
import { evaluateStepUp } from '@kilocode/web-shared/lib/admin/step-up-store';
import { STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS } from '@kilocode/web-shared/lib/admin/step-up-policy';
import { getLowerDomainFromEmail } from '@kilocode/web-shared/lib/email-address';
import {
  resolveSsoAuthorityForDomain,
  type SsoDomainAuthority,
} from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { recordAdminAction, userActionTarget } from '@/lib/admin/admin-action-audit';
import type { SignInMethodChangeRefusal } from '@/lib/auth/sign-in-method-change-codes';

export type SignInMethodChange = 'link' | 'unlink';

/** The browser session claims that prove when and how the session signed in. */
export type SignInMethodChangeSession = {
  webSessionId?: string;
  /** Unix seconds when this browser session signed in. */
  authenticatedAt?: number;
  /** The WorkOS organization the session signed in through, when it used SSO. */
  ssoSourceOrganizationId?: string;
};

/**
 * Whether this browser session proved its holder recently: a primary sign-in
 * in the last ten minutes, or a live step-up proof for this session. Passkey
 * enrollment and sign-in method changes use the same rule. A failed step-up
 * read throws, so the caller fails closed.
 */
export async function isRecentlyProvenSession(params: {
  userId: string;
  webSessionId?: string;
  authenticatedAt?: number;
}): Promise<boolean> {
  if (
    typeof params.authenticatedAt === 'number' &&
    Date.now() - params.authenticatedAt * 1000 <= STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS
  ) {
    return true;
  }
  if (!params.webSessionId) return false;
  const evaluation = await evaluateStepUp({
    userId: params.userId,
    webSessionId: params.webSessionId,
    actionClass: 'platform_read',
  });
  return evaluation.state.status === 'fresh';
}

async function ssoAuthorityForUser(user: Pick<User, 'google_user_email'>) {
  const domain = getLowerDomainFromEmail(user.google_user_email);
  return domain ? resolveSsoAuthorityForDomain(domain) : null;
}

async function organizationAllowsNonSsoSignInMethods(organizationId: string): Promise<boolean> {
  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
    columns: { settings: true },
  });
  return organization?.settings.allow_non_sso_sign_in_methods === true;
}

/**
 * Whether the account may gain a sign-in method that is not its SSO. An
 * account whose domain requires SSO may not, unless the organization that
 * owns the domain allows it. A domain whose SSO authority is misconfigured
 * refuses.
 */
async function linkAllowedBySsoPolicy(authority: SsoDomainAuthority | null): Promise<boolean> {
  if (!authority || authority.status === 'not_required') return true;
  if (authority.status === 'misconfigured') return false;
  return organizationAllowsNonSsoSignInMethods(authority.sourceOrganizationId);
}

/** The SSO policy check alone, for the link callback that completes a started link. */
export async function isSignInMethodLinkAllowed(
  user: Pick<User, 'google_user_email'>
): Promise<boolean> {
  return linkAllowedBySsoPolicy(await ssoAuthorityForUser(user));
}

/**
 * Decides whether a browser session may link or unlink a sign-in method. A
 * sign-in method is a way into the account, so the change needs a recent
 * proof of the person, not only a live session:
 *
 * - a link for an account whose domain requires SSO needs the organization
 *   to allow other methods;
 * - for a domain that requires SSO, the session must have signed in through
 *   that SSO in the last ten minutes, or hold a live step-up proof;
 * - for every other account, a primary sign-in in the last ten minutes, or a
 *   live step-up proof.
 *
 * Returns the refusal, or null when the change may go ahead.
 */
export async function authorizeSignInMethodChange(params: {
  user: Pick<User, 'id' | 'google_user_email'>;
  session: SignInMethodChangeSession;
  change: SignInMethodChange;
}): Promise<SignInMethodChangeRefusal | null> {
  const authority = await ssoAuthorityForUser(params.user);
  if (authority?.status === 'misconfigured') return 'ssoLinkNotAllowed';
  if (params.change === 'link' && !(await linkAllowedBySsoPolicy(authority))) {
    return 'ssoLinkNotAllowed';
  }

  const ssoRequired = authority?.status === 'required';
  const signedInThroughRequiredSso =
    !ssoRequired || params.session.ssoSourceOrganizationId === authority.sourceOrganizationId;
  const proven = await isRecentlyProvenSession({
    userId: params.user.id,
    webSessionId: params.session.webSessionId,
    // A recent sign-in counts for an SSO domain only when it used that SSO.
    authenticatedAt: signedInThroughRequiredSso ? params.session.authenticatedAt : undefined,
  });
  return proven ? null : 'reauthRequired';
}

/**
 * Records a sign-in method change in the audit logs. A platform admin's change
 * goes to the admin action log; a change on an account whose domain requires
 * SSO goes to that organization's audit log; every other change is a
 * structured log line. Provider account addresses are never recorded.
 *
 * The change has already happened, so a failed write is reported and never
 * thrown.
 */
export async function recordSignInMethodChange(params: {
  user: Pick<User, 'id' | 'google_user_email' | 'google_user_name' | 'is_admin' | 'is_super_admin'>;
  change: SignInMethodChange;
  provider: AuthProviderId;
  request?: { ip?: string | null; route?: string };
}): Promise<void> {
  const { user, change, provider } = params;
  const providerName = AUTH_PROVIDER_DISPLAY_NAMES[provider];
  try {
    if (user.is_admin) {
      await recordAdminAction(
        {
          user,
          authViaToken: false,
          ip: params.request?.ip ?? null,
          auditRoute: params.request?.route,
        },
        {
          action: change === 'link' ? 'admin.sign_in_method.link' : 'admin.sign_in_method.unlink',
          target: userActionTarget(user.id),
          message:
            change === 'link'
              ? `Linked a ${providerName} sign-in method`
              : `Unlinked a ${providerName} sign-in method`,
          metadata: { provider },
        }
      );
    } else {
      logExceptInTest(
        JSON.stringify({
          event: 'sign_in_method_change',
          change,
          provider,
          kiloUserId: user.id,
          ip: params.request?.ip ?? null,
          route: params.request?.route ?? null,
        })
      );
    }

    const authority = await ssoAuthorityForUser(user);
    if (authority?.status === 'required') {
      await createAuditLog({
        action:
          change === 'link'
            ? 'organization.user.link_sign_in_method'
            : 'organization.user.unlink_sign_in_method',
        actor_id: user.id,
        actor_email: user.google_user_email,
        actor_name: user.google_user_name,
        organization_id: authority.sourceOrganizationId,
        message:
          change === 'link'
            ? `User linked a ${providerName} sign-in method`
            : `User unlinked a ${providerName} sign-in method`,
      });
    }
  } catch (error) {
    captureException(error, {
      tags: { operation: 'sign_in_method_change_audit' },
      extra: { change, provider },
    });
  }
}

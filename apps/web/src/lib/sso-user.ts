import type { CreateOrUpdateUserArgs } from '@/lib/user';
import { createOrUpdateUser } from '@/lib/user';
import { WORKOS_API_KEY } from '@/lib/config.server';
import { WorkOS } from '@workos-inc/node';
import 'server-only';
import { captureException } from '@sentry/nextjs';
import {
  addUserToOrganization,
  getOrganizationById,
  getOrganizationMembers,
} from '@/lib/organizations/organizations';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { sendOrgSSOUserJoinedEmail } from '@/lib/email';
import { SSO_SIGNIN_PATH } from '@/lib/auth/constants';

const workos = new WorkOS(WORKOS_API_KEY);

async function processSSOInternal(
  args: CreateOrUpdateUserArgs,
  requestHeaders?: Headers
): Promise<string | true> {
  if (args.provider !== 'workos') {
    throw new Error('Only SSO logins supported');
  }
  const userDomain = args.google_user_email.split('@').pop();
  if (!userDomain) {
    throw new Error('Invalid email address ' + args.google_user_email);
  }
  const orgs = await workos.organizations.listOrganizations({
    domains: [userDomain],
  });
  if (!orgs.data.length) {
    throw new Error(`No organization found for domain: ${userDomain}`);
  }
  if (orgs.data.length > 1) {
    throw new Error(`Multiple organizations found for domain: ${userDomain}`);
  }
  const workOSOrg = orgs.data[0];
  const orgExternalId = workOSOrg.externalId;

  if (!orgExternalId) {
    throw new Error(
      `Organization ${workOSOrg.name} (${workOSOrg.id}) is not linked to a local organization (missing external_id)`
    );
  }

  const kiloOrg = await getOrganizationById(orgExternalId);
  if (!kiloOrg) {
    throw new Error(
      `No local organization found for WorkOS organization ${workOSOrg.name} (${workOSOrg.id} - ${orgExternalId})`
    );
  }

  const res = await createOrUpdateUser(args, undefined, true, requestHeaders);
  if (!res.success) {
    if (res.error === 'SIGNUP-RATE-LIMITED') {
      return `${SSO_SIGNIN_PATH}?error=SIGNUP-RATE-LIMITED`;
    }
    throw new Error(res.error);
  }
  if (res.user.blocked_reason) {
    throw new Error('User is blocked: ' + res.user.blocked_reason);
  }

  const savedUser = res.user;
  // add user to organization since its been fully created
  const added = await addUserToOrganization(kiloOrg.id, savedUser.id, 'member');
  if (added) {
    // get all owners for org
    const members = await getOrganizationMembers(kiloOrg.id);
    const owners = members.filter(m => m.role === 'owner');
    const ownerEmails = owners.map(o => o.email);
    // send email to all owners

    for (const email of ownerEmails) {
      await sendOrgSSOUserJoinedEmail(email, {
        new_user_email: savedUser.google_user_email,
        organizationId: kiloOrg.id,
      });
    }

    // create an audit log entry to track auto provisioning
    await createAuditLog({
      action: 'organization.sso.auto_provision',
      actor_email: savedUser.google_user_email,
      actor_id: savedUser.id,
      actor_name: savedUser.google_user_name,
      message: `User joined organization via SSO`,
      organization_id: kiloOrg.id,
    });
  }

  await createAuditLog({
    action: 'organization.user.login',
    actor_email: savedUser.google_user_email,
    actor_id: savedUser.id,
    actor_name: savedUser.google_user_name,
    message: `User logged in via SSO`,
    organization_id: kiloOrg.id,
  });

  return true;
}

export async function processSSOUserLogin(args: CreateOrUpdateUserArgs, requestHeaders?: Headers) {
  try {
    return await processSSOInternal(args, requestHeaders);
  } catch (error) {
    console.error('Error processing SSO login:', error);
    captureException(error, {
      tags: { source: 'sso-user' },
      extra: { args },
    });
    return `${SSO_SIGNIN_PATH}?error=OAUTH_ERROR`;
  }
}

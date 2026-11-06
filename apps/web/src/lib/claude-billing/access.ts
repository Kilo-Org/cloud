import 'server-only';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import {
  getOrganizationById,
  getUserOrgMemberships,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { CLAUDE_BILLING_FLAG } from '@/lib/auth/claude/access';

export async function canUseClaudeBilling(userId: string) {
  if (process.env.NODE_ENV === 'development') return true;
  const user = await findUserById(userId);
  return Boolean(
    user && (await isReleaseToggleEnabled(CLAUDE_BILLING_FLAG, user.google_user_email))
  );
}

export async function canManageClaudeBillingOrganization(userId: string, organizationId: string) {
  const memberships = await getUserOrgMemberships(userId);
  if (canManageOrganization(memberships.find(entry => entry.orgId === organizationId)?.role))
    return true;
  const organization = await getOrganizationById(organizationId);
  return canManageOrganization(
    memberships.find(entry => entry.orgId === organization?.parent_organization_id)?.role
  );
}

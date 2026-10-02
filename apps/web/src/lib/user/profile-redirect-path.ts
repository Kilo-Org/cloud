import type { User } from '@kilocode/db/schema';
import {
  getSingleUserOrganization,
  getUserOrganizationsWithSeats,
} from '@/lib/organizations/organizations';
import { getMostRecentSeatPurchase } from '@/lib/organizations/organization-seat-purchases';
import { findLiveSalesDemoForUser } from '@/lib/organizations/sales-demo';
import { compareOrganizationsForDefault } from '@/lib/organizations/sales-demo-sort';
import { classifyOrganizationEntitlement } from '@/lib/organizations/trial-utils';

// Resolve where a user whose personal account is disabled should land by default.
// Prefers a sales demo org, then their oldest organization (stable across
// requests); falls back to an allowed personal route when they somehow belong
// to no organizations.
// Note: this only affects where we send them by default (e.g. after login); we
// do not block direct navigation to personal routes.
async function resolvePersonalAccountDisabledLandingPath(userId: User['id']): Promise<string> {
  const orgs = await getUserOrganizationsWithSeats(userId);
  // Old form sorted by created_at then organizationId; the shared comparator
  // additionally lets a sales-demo org win.
  const firstOrg = [...orgs].sort(compareOrganizationsForDefault)[0];
  return firstOrg ? `/organizations/${firstOrg.organizationId}` : '/connected-accounts';
}

// decides if we want to redirect to /profile or the org page
// the org page will be redirected to if the user is a member of exactly one organization
// or if the org is SSO org
export async function getProfileRedirectPath(user: User) {
  // Users whose personal account is disabled have no personal surface;
  // always send them into an organization regardless of org count.
  if (user.personal_account_disabled) {
    return resolvePersonalAccountDisabledLandingPath(user.id);
  }

  // Old form sent multi-org users to /profile; a live sales-demo membership
  // wins so login lands on the demo org.
  const salesDemoOrg = await findLiveSalesDemoForUser(user.id);
  if (salesDemoOrg) {
    return `/organizations/${salesDemoOrg.id}`;
  }

  // Check if user is a member of exactly one organization (skip redirect if multiple)
  const singleOrg = await getSingleUserOrganization(user.id);
  if (singleOrg) {
    const latestPurchase = await getMostRecentSeatPurchase(singleOrg.id);
    const classification = classifyOrganizationEntitlement({
      organization: singleOrg,
      latestSeatPurchaseStatus: latestPurchase?.subscription_status ?? null,
      now: new Date(),
    });
    if (classification.isTrialExpiredForEnforcement) {
      return '/profile';
    }
    return `/organizations/${singleOrg.id}`;
  }

  return '/profile';
}

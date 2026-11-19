import { useLocalSearchParams } from 'expo-router';

import { OrganizationBillingScreen } from '@/components/organization/billing-screen';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';
import { normalizeOrgQueryParam } from '@/lib/org-deep-link';
import { useRepairOrganizationRouteStack } from '@/lib/hooks/use-repair-organization-route-stack';

const BILLING_PATH = '/(app)/(tabs)/(3_profile)/organization/billing' as const;

export default function OrganizationBillingRoute() {
  // A link or a relaunch restore that arrives without the hub beneath it
  // rebuilds it, so Back returns to the hub instead of leaving the
  // organization tree.
  useRepairOrganizationRouteStack({ self: BILLING_PATH });
  // A refusal step carries the organization whose role it resolved, so the
  // screen reads its scope from the query. This is an in-app push, not a link
  // that re-scopes the account: the param is never persisted as the selection,
  // which keeps the account switcher's choice the only thing it writes.
  const { org: rawOrg } = useLocalSearchParams<{ org?: string | string[] }>();
  const orgIdOverride = normalizeOrgQueryParam(rawOrg);
  // The numbers belong to the account they were opened under, and a push that
  // names its own organization is a scope the reader asked for.
  const stale = useLeaveStaleOrganizationScope({
    namesOwnOrganization: orgIdOverride !== undefined,
  });
  if (stale) {
    return null;
  }
  return <OrganizationBillingScreen organizationIdOverride={orgIdOverride} />;
}

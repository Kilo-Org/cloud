import { type Href, useLocalSearchParams } from 'expo-router';

import { OrganizationBillingScreen } from '@/components/organization/billing-screen';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';
import { normalizeOrgQueryParam } from '@/lib/org-deep-link';
import { useRepairOrganizationRouteStack } from '@/lib/hooks/use-repair-organization-route-stack';

const BILLING_PATH = '/(app)/(tabs)/(3_profile)/organization/billing' as const;

export default function OrganizationBillingRoute() {
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
  // A link or a relaunch restore that arrives without the hub beneath it
  // rebuilds it, so Back returns to the hub instead of leaving the
  // organization tree. The href carries the org the link named, the same way
  // `credit-activity.tsx` builds its `self`: the rebuilt push is a query
  // string, because the object form drops params (`profile-route-stack.ts`),
  // and a rebuilt billing screen without its org would fall back to the
  // persisted selection.
  const self =
    orgIdOverride !== undefined
      ? (`${BILLING_PATH}?org=${encodeURIComponent(orgIdOverride)}` as Href)
      : BILLING_PATH;
  useRepairOrganizationRouteStack({ self });
  if (stale) {
    return null;
  }
  return <OrganizationBillingScreen organizationIdOverride={orgIdOverride} />;
}

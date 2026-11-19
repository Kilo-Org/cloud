import { type Href, useLocalSearchParams } from 'expo-router';

import { OrganizationCreditActivityScreen } from '@/components/organization/credit-activity-screen';
import { useRepairOrganizationRouteStack } from '@/lib/hooks/use-repair-organization-route-stack';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';
import { normalizeOrgQueryParam } from '@/lib/org-deep-link';

/** The path that re-opens this screen above the organization hub. */
const CREDIT_ACTIVITY_PATH = '/(app)/(tabs)/(3_profile)/organization/credit-activity';

export default function OrganizationCreditActivityRoute() {
  const { org: rawOrg } = useLocalSearchParams<{ org?: string | string[] }>();
  const orgParam = normalizeOrgQueryParam(rawOrg);
  // A link that names an organization selects it (`credit-activity-screen.tsx`),
  // so it is a scope the reader asked for and keeps its own account; the plain
  // route belongs to the account it was opened under.
  const stale = useLeaveStaleOrganizationScope({
    namesOwnOrganization: orgParam !== undefined,
  });
  // A link or a relaunch restore that arrives without the hub beneath it
  // rebuilds it, so Back returns to the hub instead of leaving the
  // organization tree. The href carries the org the link named: the rebuilt
  // push is a query string, because the object form drops params
  // (`profile-route-stack.ts`), and a rebuilt link screen without its org
  // would re-scope to the persisted selection.
  const self: Href =
    orgParam !== undefined
      ? `${CREDIT_ACTIVITY_PATH}?org=${encodeURIComponent(orgParam)}`
      : CREDIT_ACTIVITY_PATH;
  useRepairOrganizationRouteStack({ self });
  if (stale) {
    return null;
  }
  return <OrganizationCreditActivityScreen />;
}

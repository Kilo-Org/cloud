import { useLocalSearchParams } from 'expo-router';

import { OrganizationCreditActivityScreen } from '@/components/organization/credit-activity-screen';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';
import { normalizeCreditActivityOrgParam } from '@/lib/org-deep-link';

export default function OrganizationCreditActivityRoute() {
  const { org: rawOrg } = useLocalSearchParams<{ org?: string | string[] }>();
  // A link that names an organization selects it (`credit-activity-screen.tsx`),
  // so it is a scope the reader asked for and keeps its own account; the plain
  // route belongs to the account it was opened under.
  const stale = useLeaveStaleOrganizationScope({
    namesOwnOrganization: normalizeCreditActivityOrgParam(rawOrg) !== undefined,
  });
  if (stale) {
    return null;
  }
  return <OrganizationCreditActivityScreen />;
}

import { useLocalSearchParams } from 'expo-router';

import { OrganizationHubScreen } from '@/components/organization/hub-screen';
import { parseParam } from '@/lib/route-params';

export default function OrganizationDeepLinkRoute() {
  const { 'org-id': rawOrgId } = useLocalSearchParams<{ 'org-id': string }>();
  const orgId = parseParam(rawOrgId);

  return <OrganizationHubScreen organizationIdOverride={orgId ?? undefined} />;
}

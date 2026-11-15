import { useLocalSearchParams } from 'expo-router';

import { IntegrationsScreen } from '@/components/integrations/integrations-screen';
import { normalizeOrgQueryParam } from '@/lib/org-deep-link';

export default function IntegrationsRoute() {
  const { org } = useLocalSearchParams<{ org?: string | string[] }>();
  return <IntegrationsScreen organizationId={normalizeOrgQueryParam(org)} />;
}

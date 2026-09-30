import { useLocalSearchParams } from 'expo-router';

import { SpendAlertsScreen } from '@/components/organization/spend-alerts-screen';
import { parseParam } from '@/lib/route-params';

export default function SpendAlertsRoute() {
  const { org: rawOrg } = useLocalSearchParams<{ org?: string }>();
  return <SpendAlertsScreen organizationId={parseParam(rawOrg) ?? undefined} />;
}

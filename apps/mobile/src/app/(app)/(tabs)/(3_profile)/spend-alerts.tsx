import { useLocalSearchParams } from 'expo-router';

import { SpendAlertsScreen } from '@/components/organization/spend-alerts-screen';

export default function SpendAlertsRoute() {
  const { org } = useLocalSearchParams<{ org?: string }>();
  return <SpendAlertsScreen organizationId={org} />;
}

import { useLocalSearchParams } from 'expo-router';

import { SpendAlertsScreen } from '@/components/organization/spend-alerts-screen';
import { normalizeOrgQueryParam } from '@/lib/org-deep-link';

export default function SpendAlertsRoute() {
  const { org, settingsTarget } = useLocalSearchParams<{
    org?: string | string[];
    settingsTarget?: string;
  }>();
  return (
    <SpendAlertsScreen
      organizationId={normalizeOrgQueryParam(org)}
      settingsTarget={settingsTarget}
    />
  );
}

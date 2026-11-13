import { useLocalSearchParams } from 'expo-router';

import { IntegrationsScreen } from '@/components/integrations/integrations-screen';

export default function IntegrationsRoute() {
  const { org } = useLocalSearchParams<{ org?: string }>();
  return <IntegrationsScreen organizationId={org} />;
}

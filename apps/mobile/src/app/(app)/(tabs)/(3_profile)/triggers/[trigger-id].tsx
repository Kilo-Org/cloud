import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { TriggerDetailScreen } from '@/components/cloud-triggers/trigger-detail-screen';
import { triggerScopeFromParam } from '@/lib/cloud-triggers/trigger-scope';

export default function TriggerDetailRoute() {
  const { 'trigger-id': triggerId, org } = useLocalSearchParams<{
    'trigger-id': string;
    org?: string;
  }>();
  const { i18n } = useTranslation();
  // Remount on the applied language change, the same way the triggers list and
  // profile routes do: the RTL round trip through a language switch can leave
  // this restored scene stale until the user leaves and re-enters it.
  return (
    <TriggerDetailScreen
      key={i18n.language}
      triggerId={triggerId}
      organizationId={triggerScopeFromParam(org)}
    />
  );
}

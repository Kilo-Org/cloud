import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { TriggerCreateScreen } from '@/components/cloud-triggers/trigger-create-screen';
import { triggerScopeFromParam } from '@/lib/cloud-triggers/trigger-scope';

export default function NewTriggerRoute() {
  const { org } = useLocalSearchParams<{ org?: string }>();
  const { i18n } = useTranslation();
  // Remount on the applied language change, the same way the triggers list and
  // profile routes do: the RTL round trip through a language switch can leave
  // this restored scene stale until the user leaves and re-enters it.
  return <TriggerCreateScreen key={i18n.language} organizationId={triggerScopeFromParam(org)} />;
}

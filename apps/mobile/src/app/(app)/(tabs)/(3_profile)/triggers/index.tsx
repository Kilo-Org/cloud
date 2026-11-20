import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { TriggersListScreen } from '@/components/cloud-triggers/triggers-list-screen';
import { triggerScopeFromParam } from '@/lib/cloud-triggers/trigger-scope';

export default function TriggersRoute() {
  const { org } = useLocalSearchParams<{ org?: string }>();
  const { i18n } = useTranslation();
  // Remount the screen when the applied language changes, the same way the
  // profile route does: the language round trip through an RTL language forces
  // two native reloads, and this restored scene can come back stale across one
  // until the user leaves and re-enters the screen. Only the list carries the
  // key: the create and detail screens hold unsaved form state, which an
  // in-place language change would silently discard.
  return <TriggersListScreen key={i18n.language} organizationId={triggerScopeFromParam(org)} />;
}

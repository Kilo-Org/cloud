import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { NewSessionScreenBody } from '@/components/agents/new-session-screen-body';
import { NewSessionModelProvider } from '@/components/agents/new-session-model-provider';
import { useNewSessionOrganization } from '@/components/agents/use-new-session-organization';
import { ScreenHeader } from '@/components/screen-header';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

export default function NewSessionScreen() {
  const { t } = useTranslation();
  const { organizationId, isResolved } = useNewSessionOrganization();
  // Nothing account-scoped mounts before the account is known: the model
  // catalog, the repositories, the profiles and the create all take this value,
  // and an unresolved one reads as Personal. Resolving takes a stored-choice
  // read, so the wait is a frame in the common case.
  if (!isResolved) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.newSession')} />
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      </View>
    );
  }
  return (
    <NewSessionModelProvider organizationId={organizationId}>
      <NewSessionScreenBody />
    </NewSessionModelProvider>
  );
}

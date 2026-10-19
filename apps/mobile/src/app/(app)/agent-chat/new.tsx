import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { NewSessionScreenBody } from '@/components/agents/new-session-screen-body';
import { NewSessionModelProvider } from '@/components/agents/new-session-model-provider';
import { useNewSessionOrganization } from '@/components/agents/use-new-session-organization';
import { ScreenHeader } from '@/components/screen-header';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Text } from '@/components/ui/text';
import { useOrganization } from '@/lib/organization-context';

export default function NewSessionScreen() {
  const { t } = useTranslation();
  const { organizationId, isResolved } = useNewSessionOrganization();
  const { error, retry } = useOrganization();
  // Nothing account-scoped mounts before the account is known: the model
  // catalog, the repositories, the profiles and the create all take this value,
  // and an unresolved one reads as Personal. A stored organization or an
  // explicit Personal choice resolves from storage; with neither, the account
  // list decides, so the wait is a network round trip and can fail.
  if (!isResolved) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.newSession')} />
        <View className="flex-1 items-center justify-center gap-3 px-4">
          {error === 'restore' ? (
            <>
              <Text className="text-center text-sm text-muted-foreground">
                {t('common.somethingWentWrong')}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('common.retry')}
                onPress={retry}
                className="min-h-11 flex-row items-center justify-center active:opacity-70"
              >
                <Text className="text-sm text-primary">{t('common.retry')}</Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator />
          )}
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

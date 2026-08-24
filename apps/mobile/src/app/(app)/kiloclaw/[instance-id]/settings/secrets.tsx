import { KeyRound } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useLocalSearchParams } from 'expo-router';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { SettingsCard } from '@/components/kiloclaw/settings-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { instanceOrgId, useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useKiloClawMutations, useKiloClawSecretCatalog } from '@/lib/hooks/use-kiloclaw-queries';

export default function SecretsScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId = instanceOrgId(instanceContext);
  const mutations = useKiloClawMutations(organizationId);
  const catalogQuery = useKiloClawSecretCatalog(organizationId);
  const isLoading = catalogQuery.isPending;
  const { t } = useTranslation();

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return (
      <InstanceContextBoundary title={t('kiloclaw.secrets.title')} context={instanceContext} />
    );
  }

  function renderBody() {
    if (isLoading) {
      return (
        <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-4 pt-4">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </Animated.View>
      );
    }

    if (catalogQuery.isError) {
      return (
        <View className="flex-1 items-center justify-center">
          <QueryError
            message={t('kiloclaw.secrets.couldNotLoad')}
            onRetry={() => {
              void catalogQuery.refetch();
            }}
          />
        </View>
      );
    }

    if (catalogQuery.data.length === 0) {
      return (
        <View className="flex-1 items-center justify-center">
          <EmptyState
            icon={KeyRound}
            title={t('kiloclaw.secrets.noSecrets')}
            description={t('kiloclaw.secrets.noSecretsDescription')}
          />
        </View>
      );
    }

    return (
      <View className="flex-1">
        <DetailScreenScrollView
          contentContainerClassName="pt-4 gap-3"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View entering={FadeIn.duration(200)} className="gap-3">
            {catalogQuery.data.map(secret => (
              <SettingsCard
                key={secret.id}
                item={secret}
                mutations={mutations}
                removeAlertTitle={t('kiloclaw.secrets.removeTitle')}
                removeAlertMessage={t('kiloclaw.secrets.removeMessage', { label: secret.label })}
                successMessage={t('kiloclaw.secrets.saved', { label: secret.label })}
              />
            ))}
          </Animated.View>
        </DetailScreenScrollView>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloclaw.secrets.title')} />
      {renderBody()}
    </View>
  );
}

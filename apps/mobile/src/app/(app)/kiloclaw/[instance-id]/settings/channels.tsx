import { MessageSquare } from '@/components/ui/icons';
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
import { useKiloClawChannelCatalog, useKiloClawMutations } from '@/lib/hooks/use-kiloclaw-queries';

export default function ChannelsScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId = instanceOrgId(instanceContext);
  const catalogQuery = useKiloClawChannelCatalog(organizationId);
  const mutations = useKiloClawMutations(organizationId);

  const isLoading = catalogQuery.isPending;
  const { t } = useTranslation();

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return (
      <InstanceContextBoundary title={t('kiloclaw.channels.title')} context={instanceContext} />
    );
  }

  function renderBody() {
    if (isLoading) {
      return (
        <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-4 pt-4">
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
            message={t('kiloclaw.channels.couldNotLoad')}
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
            icon={MessageSquare}
            title={t('kiloclaw.channels.noChannels')}
            description={t('kiloclaw.channels.noChannelsDescription')}
          />
        </View>
      );
    }

    return (
      <View className="flex-1">
        <DetailScreenScrollView
          contentContainerClassName="pt-4 gap-4"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View entering={FadeIn.duration(200)} className="gap-3">
            {catalogQuery.data.map(channel => (
              <SettingsCard
                key={channel.id}
                item={channel}
                mutations={mutations}
                removeAlertTitle={t('kiloclaw.channels.disconnectTitle')}
                removeAlertMessage={t('kiloclaw.channels.disconnectMessage', {
                  label: channel.label,
                })}
                successMessage={t('kiloclaw.channels.connected', { label: channel.label })}
              />
            ))}
          </Animated.View>
        </DetailScreenScrollView>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloclaw.channels.title')} />
      {renderBody()}
    </View>
  );
}

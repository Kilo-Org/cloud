import { Newspaper } from '@/components/ui/icons';
import { Alert, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { ChangelogList } from '@/components/kiloclaw/changelog-list';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { instanceOrgId, useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useKiloClawChangelog, useKiloClawMutations } from '@/lib/hooks/use-kiloclaw-queries';

export default function ChangelogScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId = instanceOrgId(instanceContext);
  const changelogQuery = useKiloClawChangelog(organizationId);
  const mutations = useKiloClawMutations(organizationId);
  const router = useRouter();
  const entries = changelogQuery.data;
  const { t } = useTranslation();

  function handleRedeploy() {
    Alert.alert(t('kiloclaw.redeployTitle'), t('kiloclaw.redeployMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('kiloclaw.redeploy'),
        onPress: () => {
          mutations.restartMachine.mutate(undefined);
        },
      },
    ]);
  }

  function handleUpgrade() {
    router.push(`/(app)/kiloclaw/${instanceId}/settings/version-pin` as Href);
  }

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return (
      <InstanceContextBoundary title={t('kiloclaw.changelog.title')} context={instanceContext} />
    );
  }

  function renderBody() {
    if (changelogQuery.isPending) {
      return (
        <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-4 pt-4">
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
        </Animated.View>
      );
    }

    if (changelogQuery.isError) {
      return (
        <View className="flex-1 items-center justify-center">
          <QueryError
            message={t('kiloclaw.changelog.couldNotLoad')}
            onRetry={() => {
              void changelogQuery.refetch();
            }}
          />
        </View>
      );
    }

    if (!entries || entries.length === 0) {
      return (
        <View className="flex-1 items-center justify-center">
          <EmptyState
            icon={Newspaper}
            title={t('kiloclaw.changelog.noUpdates')}
            description={t('kiloclaw.changelog.noUpdatesDescription')}
          />
        </View>
      );
    }

    return (
      <DetailScreenScrollView
        contentContainerClassName="px-4 pt-4 gap-4"
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-3">
          <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t('kiloclaw.changelog.recentUpdates')}
          </Text>
          <Animated.View entering={FadeIn.duration(200)}>
            <ChangelogList
              entries={entries}
              isRedeploying={mutations.restartMachine.isPending}
              onRedeploy={handleRedeploy}
              onUpgrade={handleUpgrade}
            />
          </Animated.View>
        </View>
      </DetailScreenScrollView>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloclaw.changelog.title')} />
      {renderBody()}
    </View>
  );
}

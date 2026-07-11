import { Newspaper } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useLocalSearchParams } from 'expo-router';

import { EmptyState } from '@/components/empty-state';
import { ChangelogList } from '@/components/kiloclaw/changelog-list';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useKiloClawChangelog } from '@/lib/hooks/use-kiloclaw-queries';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

export default function ChangelogScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId =
    instanceContext.status === 'ready' ? instanceContext.organizationId : undefined;
  const changelogQuery = useKiloClawChangelog(organizationId);
  const entries = changelogQuery.data;
  const paddingBottom = useDetailScreenBottomPadding();

  function renderContent() {
    if (changelogQuery.isPending) {
      return (
        <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
        </Animated.View>
      );
    }
    if (changelogQuery.isError) {
      return (
        <QueryError
          message="Could not load changelog"
          onRetry={() => {
            void changelogQuery.refetch();
          }}
        />
      );
    }
    if (!entries || entries.length === 0) {
      return (
        <EmptyState
          icon={Newspaper}
          title="No updates yet"
          description="Changelog entries will appear here."
        />
      );
    }
    return (
      <Animated.View entering={FadeIn.duration(200)}>
        <ChangelogList entries={entries} />
      </Animated.View>
    );
  }

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="What's New" />
        <InstanceContextBoundary context={instanceContext} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="What's New" />
      <ScrollView
        contentContainerClassName="px-4 pt-4 gap-4"
        contentContainerStyle={{ paddingBottom }}
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-3">
          <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Recent Updates
          </Text>
          {renderContent()}
        </View>
      </ScrollView>
    </View>
  );
}

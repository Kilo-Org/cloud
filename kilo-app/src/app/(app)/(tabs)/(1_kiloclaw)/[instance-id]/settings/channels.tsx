import { MessageSquare } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { SettingsCard } from '@/components/kiloclaw/settings-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useKiloClawChannelCatalog, useKiloClawMutations } from '@/lib/hooks/use-kiloclaw';

export default function ChannelsScreen() {
  const catalogQuery = useKiloClawChannelCatalog();
  const mutations = useKiloClawMutations();

  const isLoading = catalogQuery.isPending;

  function renderContent() {
    if (isLoading) {
      return (
        <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-4">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </Animated.View>
      );
    }
    if (catalogQuery.isError) {
      return (
        <View className="flex-1 items-center justify-center py-12">
          <QueryError
            message="Could not load channels"
            onRetry={() => {
              void catalogQuery.refetch();
            }}
          />
        </View>
      );
    }
    if (catalogQuery.data.length === 0) {
      return (
        <View className="flex-1 items-center justify-center py-12">
          <EmptyState
            icon={MessageSquare}
            title="No channels available"
            description="Channel integrations will appear here."
          />
        </View>
      );
    }
    return (
      <Animated.View entering={FadeIn.duration(200)} className="gap-3">
        {catalogQuery.data.map(channel => (
          <SettingsCard
            key={channel.id}
            item={channel}
            mutations={mutations}
            removeAlertTitle="Disconnect Channel"
            removeAlertMessage={`Remove ${channel.label}? This channel will be disconnected.`}
            successMessage={`${channel.label} connected`}
          />
        ))}
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Channels" />
      <View className="flex-1">
        <ScrollView
          contentContainerClassName="py-4 gap-4"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          {renderContent()}
        </ScrollView>
      </View>
    </View>
  );
}

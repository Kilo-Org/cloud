import { KeyRound } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useLocalSearchParams } from 'expo-router';

import { EmptyState } from '@/components/empty-state';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { SettingsCard } from '@/components/kiloclaw/settings-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useKiloClawMutations, useKiloClawSecretCatalog } from '@/lib/hooks/use-kiloclaw-queries';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

export default function SecretsScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId =
    instanceContext.status === 'ready' ? instanceContext.organizationId : undefined;
  const mutations = useKiloClawMutations(organizationId);
  const catalogQuery = useKiloClawSecretCatalog(organizationId);
  const paddingBottom = useDetailScreenBottomPadding();
  const isLoading = catalogQuery.isPending;

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Secrets" />
        <InstanceContextBoundary context={instanceContext} />
      </View>
    );
  }

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Secrets" />
        <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-4 pt-4">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </Animated.View>
      </View>
    );
  }

  if (catalogQuery.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Secrets" />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message="Could not load secrets"
            onRetry={() => {
              void catalogQuery.refetch();
            }}
          />
        </View>
      </View>
    );
  }

  if (catalogQuery.data.length === 0) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Secrets" />
        <View className="flex-1 items-center justify-center">
          <EmptyState
            icon={KeyRound}
            title="No secrets available"
            description="Secret integrations will appear here."
          />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Secrets" />
      <View className="flex-1">
        <ScrollView
          contentContainerClassName="pt-4 gap-3"
          contentContainerStyle={{ paddingBottom }}
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
                removeAlertTitle="Remove Secret"
                removeAlertMessage={`Remove ${secret.label}? This tool will lose access to its credentials.`}
                successMessage={`${secret.label} saved`}
              />
            ))}
          </Animated.View>
        </ScrollView>
      </View>
    </View>
  );
}

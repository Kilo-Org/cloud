import { KeyRound } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { SettingsCard } from '@/components/kiloclaw/settings-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useKiloClawMutations, useKiloClawSecretCatalog } from '@/lib/hooks/use-kiloclaw';

export default function SecretsScreen() {
  const mutations = useKiloClawMutations();
  const catalogQuery = useKiloClawSecretCatalog();
  const isLoading = catalogQuery.isPending;

  function renderContent() {
    if (isLoading) {
      return (
        <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-4">
          <Skeleton className="h-24 w-full rounded-lg" />
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
            message="Could not load secrets"
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
            icon={KeyRound}
            title="No secrets available"
            description="Secret integrations will appear here."
          />
        </View>
      );
    }
    return (
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
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Secrets" />
      <View className="flex-1">
        <ScrollView
          contentContainerClassName="pt-4 gap-3"
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

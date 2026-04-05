import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Plus, Server } from 'lucide-react-native';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { InstanceRow } from '@/components/kiloclaw/instance-row';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAppContext } from '@/lib/context/context-context';
import { useKiloClawBillingStatus, useKiloClawStatus } from '@/lib/hooks/use-kiloclaw';
import { deriveLockReason } from '@/lib/hooks/use-kiloclaw-billing';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export default function KiloClawInstanceList() {
  const router = useRouter();
  const colors = useThemeColors();
  const { context, clearContext } = useAppContext();
  const isPersonal = context?.type === 'personal' || context == null;

  const statusQuery = useKiloClawStatus(isPersonal);
  const billingQuery = useKiloClawBillingStatus(isPersonal);

  const status = statusQuery.data;
  const billing = billingQuery.data;
  const lockReason = billing ? deriveLockReason(billing) : undefined;

  const isLoading = isPersonal && (statusQuery.isPending || billingQuery.isPending);

  const instanceId = status?.sandboxId ?? 'default';
  const billingPath = `/(app)/(tabs)/(1_kiloclaw)/${instanceId}/billing` as const;
  const chatPath = `/(app)/chat/${instanceId}` as const;
  const dashboardPath = `/(app)/(tabs)/(1_kiloclaw)/${instanceId}/dashboard` as const;

  const isDestroying = status?.status === 'destroying';

  const handlePress = () => {
    if (isDestroying) {
      return;
    }
    if (lockReason) {
      router.push(billingPath);
    } else {
      router.push(chatPath);
    }
  };

  const handleSettingsPress = () => {
    if (isDestroying) {
      return;
    }
    if (lockReason) {
      router.push(billingPath);
    } else {
      router.push(dashboardPath);
    }
  };

  function renderPersonalContent() {
    if (isLoading) {
      return (
        <Animated.View exiting={FadeOut.duration(150)}>
          <Skeleton className="h-16 w-full rounded-lg" />
        </Animated.View>
      );
    }
    if (statusQuery.isError || billingQuery.isError) {
      return (
        <Animated.View
          entering={FadeIn.duration(200)}
          className="flex-1 items-center justify-center"
        >
          <QueryError
            message="Could not load your instance"
            onRetry={() => {
              void statusQuery.refetch();
              void billingQuery.refetch();
            }}
          />
        </Animated.View>
      );
    }
    if (!status?.sandboxId) {
      return (
        <Animated.View
          entering={FadeIn.duration(200)}
          className="flex-1 items-center justify-center"
        >
          <EmptyState
            icon={Server}
            title="No KiloClaw instances"
            description="You don't have any KiloClaw instances yet."
            action={
              <Button
                variant="outline"
                onPress={() => {
                  void WebBrowser.openBrowserAsync('https://app.kilo.ai/claw');
                }}
              >
                <Plus size={16} color={colors.foreground} />
                <Text>Create</Text>
              </Button>
            }
          />
        </Animated.View>
      );
    }
    return (
      <Animated.View entering={FadeIn.duration(200)}>
        <InstanceRow
          name={status.name}
          sandboxId={status.sandboxId}
          status={status.status}
          disabled={isDestroying}
          onPress={handlePress}
          onSettingsPress={handleSettingsPress}
        />
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="KiloClaw" headerRight={<ProfileAvatarButton />} />
      <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4">
        {isPersonal ? (
          renderPersonalContent()
        ) : (
          <Animated.View
            entering={FadeIn.duration(200)}
            className="flex-1 items-center justify-center"
          >
            <EmptyState
              icon={Server}
              title="Not available for organizations"
              description="KiloClaw is only available for personal accounts."
              action={
                <Button
                  variant="outline"
                  onPress={() => {
                    void clearContext();
                  }}
                >
                  <Text>Switch to Personal</Text>
                </Button>
              }
            />
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}

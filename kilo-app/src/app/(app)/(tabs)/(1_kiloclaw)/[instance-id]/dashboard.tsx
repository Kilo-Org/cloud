import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { AlertTriangle, CreditCard, Newspaper, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { BillingBanner } from '@/components/kiloclaw/billing-banner';
import { InstanceControls } from '@/components/kiloclaw/instance-controls';
import { RenameInstanceModal } from '@/components/kiloclaw/rename-instance-modal';
import { SettingsList } from '@/components/kiloclaw/settings-list';
import { StatusCard } from '@/components/kiloclaw/status-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useKiloClawBillingStatus,
  useKiloClawGatewayStatus,
  useKiloClawMutations,
  useKiloClawServiceDegraded,
  useKiloClawStatus,
} from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export default function DashboardScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();

  const statusQuery = useKiloClawStatus();
  const billingQuery = useKiloClawBillingStatus();
  const serviceDegradedQuery = useKiloClawServiceDegraded();
  const mutations = useKiloClawMutations();

  const status = statusQuery.data;
  const isRunning = status?.status === 'running';

  const gatewayQuery = useKiloClawGatewayStatus(isRunning);
  const gateway = gatewayQuery.data;

  const billing = billingQuery.data;
  const isServiceDegraded = serviceDegradedQuery.data === true;
  const isLoading = statusQuery.isPending || billingQuery.isPending;

  const [renameVisible, setRenameVisible] = useState(false);

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Dashboard" />
        <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4 gap-3">
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-40 w-full rounded-lg" />
          </Animated.View>
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-10 w-full rounded-lg" />
          </Animated.View>
        </Animated.View>
      </View>
    );
  }

  if (statusQuery.isError || billingQuery.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Dashboard" />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message="Could not load dashboard"
            onRetry={() => {
              void statusQuery.refetch();
              void billingQuery.refetch();
            }}
          />
        </View>
      </View>
    );
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title="Dashboard" />
      <ScrollView contentContainerClassName="gap-4 px-4 py-4" showsVerticalScrollIndicator={false}>
        <Animated.View entering={FadeIn.duration(200)} className="gap-4">
          {isServiceDegraded && (
            <Pressable
              className="flex-row items-center gap-3 rounded-lg bg-red-100 dark:bg-red-950 p-3 active:opacity-70"
              onPress={() => {
                void Linking.openURL('https://status.kilo.ai');
              }}
            >
              <AlertTriangle size={18} color={colors.foreground} />
              <Text className="flex-1 text-xs font-medium">
                Service degraded — tap to view status
              </Text>
            </Pressable>
          )}

          {billing && <BillingBanner billing={billing} />}

          <StatusCard
            status={status?.status}
            name={status?.name}
            sandboxId={status?.sandboxId}
            onRename={() => {
              setRenameVisible(true);
            }}
            region={status?.flyRegion}
            cpus={status?.machineSize?.cpus}
            memoryMb={status?.machineSize?.memory_mb}
            gatewayState={gateway?.state}
            uptime={gateway?.uptime}
            restarts={gateway?.restarts}
            lastExitCode={gateway?.lastExit?.code}
            lastExitSignal={gateway?.lastExit?.signal}
            gatewayLoading={isRunning && gatewayQuery.isPending}
          />

          <InstanceControls status={status?.status} mutations={mutations} />

          <SettingsList />

          <View className="rounded-lg bg-secondary overflow-hidden">
            <Text className="px-4 pt-3 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              More
            </Text>
            <Pressable
              className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
              onPress={() => {
                router.push(`/(app)/(tabs)/(1_kiloclaw)/${instanceId}/billing` as Href);
              }}
            >
              <CreditCard size={18} color={colors.foreground} />
              <Text className="flex-1 text-sm font-medium">Billing</Text>
            </Pressable>
            <View className="ml-14 h-px bg-border" />
            <Pressable
              className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
              onPress={() => {
                router.push(`/(app)/(tabs)/(1_kiloclaw)/${instanceId}/changelog` as Href);
              }}
            >
              <Newspaper size={18} color={colors.foreground} />
              <Text className="flex-1 text-sm font-medium">What's New</Text>
            </Pressable>
          </View>

          <View className="rounded-lg bg-red-100 dark:bg-red-950 overflow-hidden p-4 gap-3">
            <Text className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
              Danger Zone
            </Text>
            <Pressable
              disabled={mutations.destroy.isPending}
              className="flex-row items-center justify-center gap-2 rounded-md bg-red-600 dark:bg-red-700 py-2.5 px-4 active:opacity-70 disabled:opacity-50"
              onPress={() => {
                Alert.alert(
                  'Destroy Instance',
                  'This will permanently destroy your KiloClaw instance and all its data. This action cannot be undone.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Destroy',
                      style: 'destructive',
                      onPress: () => {
                        mutations.destroy.mutate(undefined, {
                          onSuccess: () => {
                            router.dismissAll();
                            router.replace('/(app)/(tabs)/(1_kiloclaw)');
                          },
                        });
                      },
                    },
                  ]
                );
              }}
            >
              {mutations.destroy.isPending ? (
                <View className="h-4 w-4 items-center justify-center">
                  <ActivityIndicator size="small" color="#ffffff" />
                </View>
              ) : (
                <Trash2 size={16} color="#ffffff" />
              )}
              <Text className="text-sm font-semibold text-white">
                {mutations.destroy.isPending ? 'Destroying…' : 'Destroy Instance'}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      </ScrollView>

      {renameVisible && (
        <RenameInstanceModal
          defaultName={status?.name ?? ''}
          onSubmit={name => {
            mutations.renameInstance.mutate({ name });
          }}
          onClose={() => {
            setRenameVisible(false);
          }}
        />
      )}
    </Animated.View>
  );
}

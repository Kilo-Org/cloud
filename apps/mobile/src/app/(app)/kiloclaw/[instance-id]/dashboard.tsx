import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { CreditCard, Newspaper, Pencil } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, Linking, Platform, Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { BillingBanner } from '@/components/kiloclaw/billing-banner';
import {
  DangerZone,
  DashboardHero,
  ServiceDegradedBanner,
} from '@/components/kiloclaw/dashboard-parts';
import { InstanceControls } from '@/components/kiloclaw/instance-controls';
import { RenameInstanceModal } from '@/components/kiloclaw/rename-instance-modal';
import { SettingsList } from '@/components/kiloclaw/settings-list';
import { StatusCard } from '@/components/kiloclaw/status-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { useInstanceContext } from '@/lib/hooks/use-instance-context';
import {
  useKiloClawBillingStatus,
  useKiloClawConfig,
  useKiloClawGatewayStatus,
  useKiloClawMutations,
  useKiloClawServiceDegraded,
  useKiloClawStatus,
} from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { formatModelName, stripModelPrefix } from '@/lib/model-id';

export default function DashboardScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const { organizationId, isResolved, isOrg } = useInstanceContext(instanceId);

  const statusQuery = useKiloClawStatus(organizationId);
  const isPersonal = isResolved && !isOrg;
  const billingQuery = useKiloClawBillingStatus(isPersonal);
  const serviceDegradedQuery = useKiloClawServiceDegraded();
  const mutations = useKiloClawMutations(organizationId);

  const status = statusQuery.data;
  const isRunning = status?.status === 'running';

  const gatewayQuery = useKiloClawGatewayStatus(organizationId, isRunning);
  const gateway = gatewayQuery.data;
  const configQuery = useKiloClawConfig(organizationId);
  const activeModel = formatModelName(stripModelPrefix(configQuery.data?.kilocodeDefaultModel));

  const billing = billingQuery.data;
  const isServiceDegraded = serviceDegradedQuery.data === true;
  const isLoading = statusQuery.isPending || (isPersonal && billingQuery.isPending);

  const [renameVisible, setRenameVisible] = useState(false);

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Dashboard" />
        <Animated.View layout={LinearTransition} className="flex-1 gap-3 px-[22px] pt-4">
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-40 w-full rounded-2xl" />
          </Animated.View>
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-10 w-full rounded-2xl" />
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

  const instanceName = status?.name ?? status?.sandboxId ?? 'Instance';

  const handleDestroy = () => {
    Alert.alert(
      'Destroy Instance',
      'This will permanently destroy your KiloClaw instance and all its data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Destroy',
          style: 'destructive',
          onPress: () => {
            mutations.destroy.mutate(undefined);
            router.dismissAll();
            router.replace('/(app)/(tabs)/(0_home)' as Href);
          },
        },
      ]
    );
  };

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader
        headerRight={
          <Pressable
            onPress={() => {
              setRenameVisible(true);
            }}
            hitSlop={8}
            accessibilityLabel="Rename instance"
            className="active:opacity-70"
          >
            <Pencil size={18} color={colors.mutedForeground} />
          </Pressable>
        }
      />
      <ScrollView contentContainerClassName="pb-8" showsVerticalScrollIndicator={false}>
        <Animated.View entering={FadeIn.duration(200)} className="gap-4">
          <DashboardHero
            name={instanceName}
            status={status?.status ?? 'unknown'}
            uptime={gateway?.uptime}
          />

          {isServiceDegraded && (
            <ServiceDegradedBanner
              onPress={() => {
                void Linking.openURL('https://status.kilo.ai');
              }}
            />
          )}

          {isPersonal && billing && Platform.OS !== 'ios' ? (
            <View className="mx-[22px]">
              <BillingBanner billing={billing} />
            </View>
          ) : null}

          <View className="mx-[22px]">
            <StatusCard
              region={status?.flyRegion}
              cpus={status?.machineSize?.cpus}
              memoryMb={status?.machineSize?.memory_mb}
              gatewayState={gateway?.state}
              uptime={gateway?.uptime}
              restarts={gateway?.restarts}
              lastExitCode={gateway?.lastExit?.code}
              lastExitSignal={gateway?.lastExit?.signal}
              activeModel={activeModel}
            />
          </View>

          <View className="mx-[22px]">
            <InstanceControls status={status?.status} mutations={mutations} />
          </View>

          <View className="mx-[22px]">
            <SettingsList />
          </View>

          <View className="mx-[22px] overflow-hidden rounded-2xl border border-border bg-card px-4">
            {isPersonal && Platform.OS !== 'ios' ? (
              <ConfigureRow
                icon={CreditCard}
                title="Billing"
                onPress={() => {
                  router.push(`/(app)/kiloclaw/${instanceId}/billing` as Href);
                }}
              />
            ) : null}
            <ConfigureRow
              icon={Newspaper}
              title="What's New"
              last
              onPress={() => {
                router.push(`/(app)/kiloclaw/${instanceId}/changelog` as Href);
              }}
            />
          </View>

          <DangerZone pending={mutations.destroy.isPending} onDestroy={handleDestroy} />
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

import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { CreditCard, Newspaper, Pencil } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Alert, Linking, Platform, Pressable, RefreshControl, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { BillingBanner } from '@/components/kiloclaw/billing-banner';
import {
  DangerZone,
  DashboardHero,
  DashboardServiceStatus,
  StatusCardGroupSkeleton,
} from '@/components/kiloclaw/dashboard-parts';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { InstanceControls } from '@/components/kiloclaw/instance-controls';
import { SettingsList } from '@/components/kiloclaw/settings-list';
import { StatusCard } from '@/components/kiloclaw/status-card';
import { QueryError } from '@/components/query-error';
import { RenameModal } from '@/components/rename-modal';
import { ScreenHeader } from '@/components/screen-header';
import { captureEvent, INSTANCE_ACTION_EVENT } from '@/lib/analytics/posthog';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { instanceOrgId, useInstanceContext } from '@/lib/hooks/use-instance-context';
import {
  useKiloClawBillingStatus,
  useKiloClawConfig,
  useKiloClawGatewayStatus,
  useKiloClawMutations,
  useKiloClawServiceDegraded,
  useKiloClawStatus,
} from '@/lib/hooks/use-kiloclaw-queries';
import { useManualRefresh } from '@/lib/hooks/use-manual-refresh';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { formatModelName, stripModelPrefix } from '@/lib/model-id';

export default function DashboardScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId = instanceOrgId(instanceContext);
  const isOrg = instanceContext.status === 'ready' && instanceContext.isOrg;

  const statusQuery = useKiloClawStatus(organizationId);
  const isPersonal = instanceContext.status === 'ready' && !isOrg;
  const billingQuery = useKiloClawBillingStatus(isPersonal);
  const serviceDegradedQuery = useKiloClawServiceDegraded();
  const mutations = useKiloClawMutations(organizationId);

  const status = statusQuery.data;
  const isRunning = status?.status === 'running';

  const gatewayQuery = useKiloClawGatewayStatus(organizationId, isRunning);
  // Gateway data stays cached when the query is disabled (instance not running)
  // or errors on refetch, so scope it to a live successful read — otherwise a
  // stopped/errored instance shows stale "running" state and uptime as if live.
  const gateway = isRunning && !gatewayQuery.isError ? gatewayQuery.data : undefined;
  const configQuery = useKiloClawConfig(organizationId);
  const activeModel = formatModelName(stripModelPrefix(configQuery.data?.kilocodeDefaultModel));

  const billing = billingQuery.data;
  const isServiceDegraded = serviceDegradedQuery.data === true;
  const isLoading = statusQuery.isPending || (isPersonal && billingQuery.isPending);

  const [renameVisible, setRenameVisible] = useState(false);
  const refetchStatus = statusQuery.refetch;
  const refetchBilling = billingQuery.refetch;
  const refetchServiceDegraded = serviceDegradedQuery.refetch;
  const refetchGateway = gatewayQuery.refetch;
  const refetchConfig = configQuery.refetch;

  const refetchAll = useCallback(async () => {
    const refreshes = [
      refetchStatus(),
      refetchConfig(),
      refetchServiceDegraded(),
      ...(isRunning ? [refetchGateway()] : []),
      ...(isPersonal ? [refetchBilling()] : []),
    ];
    const results = await Promise.all(refreshes);
    return { isError: results.some(result => result.isError) };
  }, [
    refetchBilling,
    refetchConfig,
    refetchGateway,
    refetchServiceDegraded,
    refetchStatus,
    isPersonal,
    isRunning,
  ]);
  const [manualRefreshing, handleRefresh] = useManualRefresh(
    refetchAll,
    "Couldn't refresh. Pull down to try again."
  );

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return <InstanceContextBoundary title="Dashboard" context={instanceContext} />;
  }

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Dashboard" />
        <Animated.View layout={LinearTransition} className="flex-1 gap-4 px-[22px] pt-4">
          <Animated.View exiting={FadeOut.duration(150)} className="gap-4">
            {/* Hero */}
            <View className="flex-row items-center gap-3 pb-2">
              <Skeleton className="h-11 w-11 rounded-[14px]" />
              <View className="flex-1 gap-1.5">
                <Skeleton className="h-7 w-40 rounded" />
                <Skeleton className="h-3 w-24 rounded" />
              </View>
            </View>
            {/* Status card: "Gateway Process" (5 rows) + "Resources" (3 rows) */}
            <View className="gap-3">
              <StatusCardGroupSkeleton rows={5} />
              <StatusCardGroupSkeleton rows={3} />
            </View>
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

  // Prefer the instance's friendly name from the list/context (the gateway
  // status query doesn't carry it, so relying on status.name showed the raw
  // sandbox id for named instances).
  const contextName =
    instanceContext.status === 'ready' ? instanceContext.instance.name : undefined;
  const instanceName = contextName ?? status?.name ?? status?.sandboxId ?? 'Instance';

  const handleDestroy = () => {
    Alert.alert(
      'Destroy instance',
      'This will permanently destroy your KiloClaw instance and all its data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Destroy',
          style: 'destructive',
          onPress: () => {
            captureEvent(INSTANCE_ACTION_EVENT, { surface: 'claw', action: 'destroy' });
            // Stay on screen while the mutation is pending — DangerZone shows
            // its own pending UI — and only navigate away once destruction
            // actually succeeds. On error the centralized mutation hook
            // toasts the failure and we stay put with context intact.
            mutations.destroy.mutate(undefined, {
              onSuccess: () => {
                router.dismissAll();
                router.replace('/(app)/(tabs)/(0_home)' as Href);
              },
            });
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
            // 18px icon + 13 slop each side = 44pt minimum touch target
            hitSlop={13}
            accessibilityLabel="Rename instance"
            className="active:opacity-70"
          >
            <Pencil size={18} color={colors.mutedForeground} />
          </Pressable>
        }
      />
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="flex-grow"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={manualRefreshing}
            onRefresh={handleRefresh}
            colors={[colors.mutedForeground]}
            tintColor={colors.mutedForeground}
          />
        }
      >
        <Animated.View entering={FadeIn.duration(200)} className="gap-4">
          <DashboardHero
            name={instanceName}
            status={status?.status ?? 'unknown'}
            uptime={gateway?.uptime}
          />

          <DashboardServiceStatus
            isError={serviceDegradedQuery.isError}
            isFetching={serviceDegradedQuery.isFetching}
            isDegraded={isServiceDegraded}
            onRetry={() => void serviceDegradedQuery.refetch()}
            onOpenStatusPage={() => {
              void Linking.openURL('https://status.kilo.ai');
            }}
          />

          {isPersonal && billing && Platform.OS !== 'ios' ? (
            <View className="mx-[22px]">
              <BillingBanner billing={billing} />
            </View>
          ) : null}

          <View className="mx-[22px] gap-2">
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
            {/* Gateway/config are optional live detail on top of the essential
                status fields above — on failure the dashes StatusCard already
                renders for missing values are indistinguishable from "no
                data", so call out the failure and offer a retry instead. */}
            {gatewayQuery.isError || configQuery.isError ? (
              <QueryError
                variant="neutral"
                placement="top"
                title="Some live details failed to load"
                onRetry={() => {
                  void gatewayQuery.refetch();
                  void configQuery.refetch();
                }}
                isRetrying={gatewayQuery.isFetching || configQuery.isFetching}
                className="rounded-2xl border border-border bg-card py-4"
              />
            ) : null}
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
      </DetailScreenScrollView>

      {renameVisible && (
        <RenameModal
          title="Rename instance"
          placeholder="Enter a new name (max 50 characters)"
          initialValue={contextName ?? status?.name ?? ''}
          onSave={async name => {
            await mutations.renameInstance.mutateAsync({ name });
          }}
          onClose={() => {
            setRenameVisible(false);
          }}
        />
      )}
    </Animated.View>
  );
}

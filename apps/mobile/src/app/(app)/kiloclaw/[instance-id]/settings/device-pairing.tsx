import { useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Monitor, RefreshCw } from '@/components/ui/icons';
import { useCallback } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useLocalSearchParams } from 'expo-router';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { CATALOG_ICONS } from '@/components/icons';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { instanceOrgId, useInstanceContext } from '@/lib/hooks/use-instance-context';
import {
  useKiloClawDevicePairing,
  useKiloClawMutations,
  useKiloClawPairing,
} from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { capitalize } from '@/lib/utils';

const CHANNEL_LABELS = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  github: 'GitHub',
} satisfies Record<string, string>;

function channelLabel(channel: string): string {
  return Object.hasOwn(CHANNEL_LABELS, channel)
    ? CHANNEL_LABELS[channel as keyof typeof CHANNEL_LABELS]
    : capitalize(channel);
}

export default function DevicePairingScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId = instanceOrgId(instanceContext);
  const colors = useThemeColors();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const pairingQuery = useKiloClawPairing(organizationId);
  const devicePairingQuery = useKiloClawDevicePairing(organizationId);
  const mutations = useKiloClawMutations(organizationId);

  const isLoading = pairingQuery.isPending || devicePairingQuery.isPending;

  const rotation = useSharedValue(0);
  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const handleRefresh = useCallback(async () => {
    rotation.value = 0;
    rotation.value = withTiming(360, {
      duration: 800,
      easing: Easing.inOut(Easing.cubic),
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: mutations.queryKeys.pairingKey }),
      queryClient.invalidateQueries({ queryKey: mutations.queryKeys.devicePairingKey }),
    ]);
  }, [queryClient, rotation, mutations.queryKeys]);

  const refreshButton = (
    <Pressable
      onPress={() => {
        void handleRefresh();
      }}
      className="p-2 active:opacity-70"
      // 18px icon + p-2 = 34pt; slop brings the target to 44pt.
      hitSlop={5}
      accessibilityRole="button"
      accessibilityLabel={t('kiloclaw.devicePairing.refreshRequests')}
    >
      <Animated.View style={spinStyle}>
        <RefreshCw size={18} color={colors.foreground} />
      </Animated.View>
    </Pressable>
  );

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return (
      <InstanceContextBoundary
        title={t('kiloclaw.devicePairing.title')}
        context={instanceContext}
      />
    );
  }

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('kiloclaw.devicePairing.title')} headerRight={refreshButton} />
        <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4 gap-3">
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-16 w-full rounded-lg" />
          </Animated.View>
        </Animated.View>
      </View>
    );
  }

  if (pairingQuery.isError || devicePairingQuery.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('kiloclaw.devicePairing.title')} headerRight={refreshButton} />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message={t('kiloclaw.devicePairing.couldNotLoad')}
            onRetry={() => {
              void handleRefresh();
            }}
          />
        </View>
      </View>
    );
  }

  const channelRequests = pairingQuery.data.requests;
  const deviceRequests = devicePairingQuery.data.requests;
  const hasAnyRequests = channelRequests.length > 0 || deviceRequests.length > 0;

  function handleApproveChannel(channel: string, code: string) {
    const label = channelLabel(channel);
    Alert.alert(
      t('kiloclaw.devicePairing.approveTitle'),
      t('kiloclaw.devicePairing.approveMessage', { label, code }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.approve'),
          onPress: () => {
            mutations.approvePairingRequest.mutate({ channel, code });
          },
        },
      ]
    );
  }

  function handleApproveDevice(
    requestId: string,
    platform = t('kiloclaw.devicePairing.unknownDevice')
  ) {
    Alert.alert(
      t('kiloclaw.devicePairing.approveDeviceTitle'),
      t('kiloclaw.devicePairing.approveDeviceMessage', { platform }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.approve'),
          onPress: () => {
            mutations.approveDevicePairingRequest.mutate({ requestId });
          },
        },
      ]
    );
  }

  if (!hasAnyRequests) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('kiloclaw.devicePairing.title')} headerRight={refreshButton} />
        <Animated.View
          entering={FadeIn.duration(200)}
          className="flex-1 items-center justify-center"
        >
          <EmptyState
            icon={Monitor}
            title={t('kiloclaw.devicePairing.noPending')}
            description={t('kiloclaw.devicePairing.noPendingDescription')}
          />
        </Animated.View>
      </View>
    );
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title={t('kiloclaw.devicePairing.title')} headerRight={refreshButton} />
      <DetailScreenScrollView
        contentContainerClassName="px-4 pt-4 gap-4"
        showsVerticalScrollIndicator={false}
      >
        {channelRequests.length > 0 && (
          <Animated.View entering={FadeIn.duration(200)} className="gap-3">
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {t('kiloclaw.devicePairing.channelRequests')}
            </Text>
            <View className="rounded-lg bg-secondary overflow-hidden">
              {channelRequests.map((request, index) => {
                const ChannelIcon = CATALOG_ICONS[request.channel];
                const isThisPending =
                  mutations.approvePairingRequest.isPending &&
                  mutations.approvePairingRequest.variables.channel === request.channel &&
                  mutations.approvePairingRequest.variables.code === request.code;
                return (
                  <View key={`${request.channel}-${request.code}`}>
                    {index > 0 && <View className="ml-4 h-px bg-border" />}
                    <View className="flex-row items-center gap-3 px-4 py-3">
                      {ChannelIcon ? (
                        <ChannelIcon size={18} />
                      ) : (
                        <MessageSquare size={18} color={colors.foreground} />
                      )}
                      <View className="flex-1 gap-0.5">
                        <Text className="text-sm font-medium">{channelLabel(request.channel)}</Text>
                        <View className="flex-row items-center gap-1.5">
                          <View className="rounded bg-muted px-1.5 py-0.5">
                            <Text className="text-xs font-mono text-muted-foreground">
                              {request.code}
                            </Text>
                          </View>
                        </View>
                      </View>
                      <Button
                        size="sm"
                        loading={isThisPending}
                        disabled={mutations.approvePairingRequest.isPending}
                        onPress={() => {
                          handleApproveChannel(request.channel, request.code);
                        }}
                      >
                        <Text>{t('common.approve')}</Text>
                      </Button>
                    </View>
                  </View>
                );
              })}
            </View>
          </Animated.View>
        )}

        {deviceRequests.length > 0 && (
          <Animated.View entering={FadeIn.duration(200)} className="gap-3">
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {t('kiloclaw.devicePairing.deviceRequests')}
            </Text>
            <View className="rounded-lg bg-secondary overflow-hidden">
              {deviceRequests.map((request, index) => {
                const isThisPending =
                  mutations.approveDevicePairingRequest.isPending &&
                  mutations.approveDevicePairingRequest.variables.requestId === request.requestId;
                return (
                  <View key={request.requestId}>
                    {index > 0 && <View className="ml-4 h-px bg-border" />}
                    <View className="flex-row items-center gap-3 px-4 py-3">
                      <Monitor size={18} color={colors.foreground} />
                      <View className="flex-1 gap-0.5">
                        <Text className="text-sm font-medium">
                          {request.role ?? t('kiloclaw.devicePairing.device')}
                        </Text>
                        <Text variant="muted" className="text-xs">
                          {[request.platform, request.requestId.slice(0, 12)]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      </View>
                      <Button
                        size="sm"
                        loading={isThisPending}
                        disabled={mutations.approveDevicePairingRequest.isPending}
                        onPress={() => {
                          handleApproveDevice(request.requestId, request.platform);
                        }}
                      >
                        <Text>{t('common.approve')}</Text>
                      </Button>
                    </View>
                  </View>
                );
              })}
            </View>
          </Animated.View>
        )}
      </DetailScreenScrollView>
    </Animated.View>
  );
}

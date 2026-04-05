import { useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Monitor, RefreshCw } from 'lucide-react-native';
import { useCallback } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { CATALOG_ICONS } from '@/components/icons';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useKiloClawDevicePairing,
  useKiloClawMutations,
  useKiloClawPairing,
} from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  github: 'GitHub',
};

export default function DevicePairingScreen() {
  const colors = useThemeColors();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const pairingQuery = useKiloClawPairing();
  const devicePairingQuery = useKiloClawDevicePairing();
  const mutations = useKiloClawMutations();

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
      queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.listPairingRequests.queryKey() }),
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.listDevicePairingRequests.queryKey(),
      }),
    ]);
  }, [queryClient, rotation, trpc]);

  const refreshButton = (
    <Pressable
      onPress={() => {
        void handleRefresh();
      }}
      className="p-2"
    >
      <Animated.View style={spinStyle}>
        <RefreshCw size={18} color={colors.foreground} />
      </Animated.View>
    </Pressable>
  );

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Device Pairing" headerRight={refreshButton} />
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
        <ScreenHeader title="Device Pairing" headerRight={refreshButton} />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message="Could not load pairing requests"
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
    const label = CHANNEL_LABELS[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
    Alert.alert(
      'Approve Pairing Request',
      `Allow ${label} (code: ${code}) to connect to your instance?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          onPress: () => {
            mutations.approvePairingRequest.mutate({ channel, code });
          },
        },
      ]
    );
  }

  function handleApproveDevice(requestId: string, platform = 'Unknown device') {
    Alert.alert('Approve Device', `Allow ${platform} to connect to your instance?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Approve',
        onPress: () => {
          mutations.approveDevicePairingRequest.mutate({ requestId });
        },
      },
    ]);
  }

  if (!hasAnyRequests) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Device Pairing" headerRight={refreshButton} />
        <Animated.View
          entering={FadeIn.duration(200)}
          className="flex-1 items-center justify-center"
        >
          <EmptyState
            icon={Monitor}
            title="No pending requests"
            description="Channel and device pairing requests will appear here."
          />
        </Animated.View>
      </View>
    );
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title="Device Pairing" headerRight={refreshButton} />
      <ScrollView contentContainerClassName="px-4 py-4 gap-4" showsVerticalScrollIndicator={false}>
        {channelRequests.length > 0 && (
          <Animated.View entering={FadeIn.duration(200)} className="gap-3">
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Channel Requests
            </Text>
            <View className="rounded-lg bg-secondary overflow-hidden">
              {channelRequests.map((request, index) => {
                const ChannelIcon = CATALOG_ICONS[request.channel];
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
                        <Text className="text-sm font-medium">
                          {CHANNEL_LABELS[request.channel] ??
                            request.channel.charAt(0).toUpperCase() + request.channel.slice(1)}
                        </Text>
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
                        onPress={() => {
                          handleApproveChannel(request.channel, request.code);
                        }}
                      >
                        <Text>Approve</Text>
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
              Device Requests
            </Text>
            <View className="rounded-lg bg-secondary overflow-hidden">
              {deviceRequests.map((request, index) => (
                <View key={request.requestId}>
                  {index > 0 && <View className="ml-4 h-px bg-border" />}
                  <View className="flex-row items-center gap-3 px-4 py-3">
                    <Monitor size={18} color={colors.foreground} />
                    <View className="flex-1 gap-0.5">
                      <Text className="text-sm font-medium">{request.role ?? 'Device'}</Text>
                      <Text variant="muted" className="text-xs">
                        {[request.platform, request.requestId.slice(0, 12)]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    <Button
                      size="sm"
                      onPress={() => {
                        handleApproveDevice(request.requestId, request.platform);
                      }}
                    >
                      <Text>Approve</Text>
                    </Button>
                  </View>
                </View>
              ))}
            </View>
          </Animated.View>
        )}
      </ScrollView>
    </Animated.View>
  );
}

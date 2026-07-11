import * as Clipboard from 'expo-clipboard';
import { RefreshCw, Unplug } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useLocalSearchParams } from 'expo-router';

import { GmailIcon, GoogleIcon } from '@/components/icons';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useInstanceContext } from '@/lib/hooks/use-instance-context';
import {
  useKiloClawGoogleSetup,
  useKiloClawMutations,
  useKiloClawStatus,
} from '@/lib/hooks/use-kiloclaw-queries';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

export default function GoogleScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId =
    instanceContext.status === 'ready' ? instanceContext.organizationId : undefined;
  const statusQuery = useKiloClawStatus(organizationId);
  const mutations = useKiloClawMutations(organizationId);
  const paddingBottom = useDetailScreenBottomPadding();
  const colors = useThemeColors();

  const [copied, setCopied] = useState(false);
  const [showRedeployPrompt, setShowRedeployPrompt] = useState(false);

  const isConnected = statusQuery.data?.googleConnected ?? false;
  const gmailEnabled = statusQuery.data?.gmailNotificationsEnabled ?? false;

  const setupQuery = useKiloClawGoogleSetup(organizationId, !statusQuery.isPending && !isConnected);

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Google Account" />
        <InstanceContextBoundary context={instanceContext} />
      </View>
    );
  }

  if (statusQuery.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Google Account" />
        <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4 gap-3">
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-16 w-full rounded-lg" />
          </Animated.View>
        </Animated.View>
      </View>
    );
  }

  if (statusQuery.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Google Account" />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message="Could not load Google account status"
            onRetry={() => {
              void statusQuery.refetch();
            }}
          />
        </View>
      </View>
    );
  }

  async function handleCopy() {
    const command = setupQuery.data?.command;
    if (!command) {
      return;
    }
    await Clipboard.setStringAsync(command);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  }

  function handleToggleGmail() {
    mutations.setGmailNotifications.mutate({ enabled: !gmailEnabled });
  }

  function handleDisconnect() {
    Alert.alert(
      'Disconnect Google',
      'Remove your Google account from this instance? This will disable Gmail notifications. Redeploy after disconnecting to apply changes.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            mutations.disconnectGoogle.mutate(undefined, {
              onSuccess: () => {
                setShowRedeployPrompt(true);
              },
            });
          },
        },
      ]
    );
  }

  function handleRedeploy() {
    Alert.alert('Redeploy Instance', 'Are you sure you want to redeploy this instance?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Redeploy',
        onPress: () => {
          mutations.restartMachine.mutate(undefined, {
            onSuccess: () => {
              setShowRedeployPrompt(false);
            },
          });
        },
      },
    ]);
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title="Google Account" />
      <ScrollView
        contentContainerClassName="px-4 pt-4 gap-4"
        contentContainerStyle={{ paddingBottom }}
        showsVerticalScrollIndicator={false}
      >
        <Animated.View entering={FadeIn.duration(200)} className="gap-4">
          {/* Connection status card */}
          <View className="rounded-lg bg-secondary p-4 min-h-[60px] justify-center">
            <View className="flex-row items-center gap-3">
              <GoogleIcon size={20} />
              <Text className="flex-1 text-base font-semibold">Google Account</Text>
              <View
                className={cn(
                  'px-2 py-1 rounded-full',
                  isConnected ? 'bg-green-200 dark:bg-green-900' : 'bg-muted'
                )}
              >
                <Text
                  className={cn(
                    'text-xs font-medium',
                    isConnected ? 'text-green-800 dark:text-green-100' : 'text-muted-foreground'
                  )}
                >
                  {isConnected ? 'Connected' : 'Not connected'}
                </Text>
              </View>
            </View>
          </View>

          {!isConnected && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-4">
              {showRedeployPrompt && (
                <View className="flex-row items-center gap-3 rounded-lg bg-amber-100 p-3 dark:bg-amber-950">
                  <Text className="flex-1 text-xs text-amber-700 dark:text-amber-300">
                    Google account disconnected. Redeploy your instance to apply the change.
                  </Text>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={mutations.restartMachine.isPending}
                    onPress={handleRedeploy}
                    className="flex-row gap-1.5"
                  >
                    {!mutations.restartMachine.isPending && (
                      <RefreshCw size={14} color={colors.foreground} />
                    )}
                    <Text>Redeploy</Text>
                  </Button>
                </View>
              )}
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Setup Command
              </Text>
              <Text variant="muted" className="text-xs">
                Run this command in a terminal with Docker installed on your own computer to connect
                your Google account.
              </Text>
              <View className="rounded-lg bg-muted p-3 gap-2">
                {setupQuery.isPending && <Skeleton className="h-4 w-full rounded" />}
                {setupQuery.isError && (
                  <View className="gap-2">
                    <Text className="text-xs text-destructive">Failed to load setup command</Text>
                    <Button
                      size="sm"
                      variant="outline"
                      loading={setupQuery.isFetching}
                      onPress={() => {
                        void setupQuery.refetch();
                      }}
                    >
                      <Text>Retry</Text>
                    </Button>
                  </View>
                )}
                {setupQuery.isSuccess && (
                  <Text className="font-mono text-xs text-foreground">
                    {setupQuery.data.command}
                  </Text>
                )}
              </View>
              <Button
                variant="outline"
                disabled={!setupQuery.data?.command}
                onPress={() => {
                  void handleCopy();
                }}
              >
                <Text>{copied ? 'Copied!' : 'Copy Command'}</Text>
              </Button>
            </Animated.View>
          )}

          {isConnected && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-4">
              <View className="rounded-lg bg-secondary p-4 min-h-[60px] justify-center">
                <View className="flex-row items-center gap-3">
                  <GmailIcon size={20} />
                  <Text className="flex-1 text-base font-semibold">Gmail Notifications</Text>
                  <Button
                    size="sm"
                    variant={gmailEnabled ? 'default' : 'outline'}
                    onPress={handleToggleGmail}
                    disabled={mutations.setGmailNotifications.isPending}
                  >
                    <Text>{gmailEnabled ? 'Enabled' : 'Disabled'}</Text>
                  </Button>
                </View>
              </View>

              <Button
                variant="outline"
                onPress={handleDisconnect}
                loading={mutations.disconnectGoogle.isPending}
                className="flex-row gap-2"
              >
                {!mutations.disconnectGoogle.isPending && <Unplug size={16} color="#ef4444" />}
                <Text className="text-destructive">Disconnect Google Account</Text>
              </Button>
            </Animated.View>
          )}
        </Animated.View>
      </ScrollView>
    </Animated.View>
  );
}

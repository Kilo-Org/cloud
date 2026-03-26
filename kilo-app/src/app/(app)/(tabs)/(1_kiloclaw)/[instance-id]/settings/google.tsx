import * as Clipboard from 'expo-clipboard';
import { Unplug } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { GmailIcon, GoogleIcon } from '@/components/icons';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useKiloClawGoogleSetup,
  useKiloClawMutations,
  useKiloClawStatus,
} from '@/lib/hooks/use-kiloclaw';
import { cn } from '@/lib/utils';
export default function GoogleScreen() {
  const statusQuery = useKiloClawStatus();
  const mutations = useKiloClawMutations();

  const [copied, setCopied] = useState(false);

  const isConnected = statusQuery.data?.googleConnected ?? false;
  const gmailEnabled = statusQuery.data?.gmailNotificationsEnabled ?? false;

  const setupQuery = useKiloClawGoogleSetup(!statusQuery.isPending && !isConnected);

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
            mutations.disconnectGoogle.mutate();
          },
        },
      ]
    );
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title="Google Account" />
      <ScrollView contentContainerClassName="px-4 py-4 gap-4" showsVerticalScrollIndicator={false}>
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
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Setup Command
              </Text>
              <View className="rounded-lg bg-muted p-3 gap-2">
                {setupQuery.isPending && <Skeleton className="h-4 w-full rounded" />}
                {setupQuery.isError && (
                  <Text className="text-xs text-destructive">Failed to load setup command</Text>
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

              <Button variant="outline" onPress={handleDisconnect} className="flex-row gap-2">
                <Unplug size={16} color="#ef4444" />
                <Text className="text-destructive">Disconnect Google Account</Text>
              </Button>
            </Animated.View>
          )}
        </Animated.View>
      </ScrollView>
    </Animated.View>
  );
}

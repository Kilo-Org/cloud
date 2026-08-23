import * as Clipboard from 'expo-clipboard';
import { RefreshCw, Unplug } from '@/components/ui/icons';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useLocalSearchParams } from 'expo-router';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { GmailIcon, GoogleIcon } from '@/components/icons';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { captureEvent, INSTANCE_ACTION_EVENT } from '@/lib/analytics/posthog';
import { instanceOrgId, useInstanceContext } from '@/lib/hooks/use-instance-context';
import {
  useKiloClawGoogleSetup,
  useKiloClawMutations,
  useKiloClawStatus,
} from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

export default function GoogleScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId = instanceOrgId(instanceContext);
  const statusQuery = useKiloClawStatus(organizationId);
  const mutations = useKiloClawMutations(organizationId);
  const colors = useThemeColors();
  const { t } = useTranslation();

  const [copied, setCopied] = useState(false);
  const [showRedeployPrompt, setShowRedeployPrompt] = useState(false);

  const isConnected = statusQuery.data?.googleConnected ?? false;
  const gmailEnabled = statusQuery.data?.gmailNotificationsEnabled ?? false;

  const setupQuery = useKiloClawGoogleSetup(organizationId, !statusQuery.isPending && !isConnected);

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return <InstanceContextBoundary title={t('kiloclaw.google.title')} context={instanceContext} />;
  }

  if (statusQuery.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('kiloclaw.google.title')} />
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
        <ScreenHeader title={t('kiloclaw.google.title')} />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message={t('kiloclaw.google.couldNotLoad')}
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
    Alert.alert(t('kiloclaw.google.disconnectTitle'), t('kiloclaw.google.disconnectMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('kiloclaw.google.disconnectConfirm'),
        style: 'destructive',
        onPress: () => {
          mutations.disconnectGoogle.mutate(undefined, {
            onSuccess: () => {
              setShowRedeployPrompt(true);
            },
          });
        },
      },
    ]);
  }

  function handleRedeploy() {
    Alert.alert(t('kiloclaw.redeployTitle'), t('kiloclaw.redeployMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('kiloclaw.redeploy'),
        onPress: () => {
          captureEvent(INSTANCE_ACTION_EVENT, { surface: 'claw', action: 'redeploy' });
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
      <ScreenHeader title={t('kiloclaw.google.title')} />
      <DetailScreenScrollView
        contentContainerClassName="px-4 pt-4 gap-4"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View entering={FadeIn.duration(200)} className="gap-4">
          {/* Connection status card */}
          <View className="rounded-lg bg-secondary p-4 min-h-[60px] justify-center">
            <View className="flex-row items-center gap-3">
              <GoogleIcon size={20} />
              <Text className="flex-1 text-base font-semibold">{t('kiloclaw.google.title')}</Text>
              <View
                className={cn(
                  'px-2 py-1 rounded-full',
                  isConnected ? 'bg-good-tile-bg' : 'bg-muted'
                )}
              >
                <Text
                  className={cn(
                    'text-xs font-medium',
                    isConnected ? 'text-good' : 'text-muted-foreground'
                  )}
                >
                  {isConnected ? t('kiloclaw.google.connected') : t('kiloclaw.google.notConnected')}
                </Text>
              </View>
            </View>
          </View>

          {!isConnected && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-4">
              {showRedeployPrompt && (
                <View className="flex-row items-center gap-3 rounded-lg bg-warn-tile-bg p-3">
                  <Text className="flex-1 text-xs text-warn">
                    {t('kiloclaw.google.disconnected')}
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
                    <Text>{t('kiloclaw.google.redeploy')}</Text>
                  </Button>
                </View>
              )}
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {t('kiloclaw.google.setupCommand')}
              </Text>
              <Text variant="muted" className="text-xs">
                {t('kiloclaw.google.setupCommandHelp')}
              </Text>
              <View className="rounded-lg bg-muted p-3 gap-2">
                {setupQuery.isPending && <Skeleton className="h-4 w-full rounded" />}
                {setupQuery.isError && (
                  <View className="gap-2">
                    <Text className="text-xs text-destructive">
                      {t('kiloclaw.google.failedToLoadCommand')}
                    </Text>
                    <Button
                      size="sm"
                      variant="outline"
                      loading={setupQuery.isFetching}
                      onPress={() => {
                        void setupQuery.refetch();
                      }}
                    >
                      <Text>{t('common.retry')}</Text>
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
                <Text>
                  {copied ? t('kiloclaw.google.copied') : t('kiloclaw.google.copyCommand')}
                </Text>
              </Button>
            </Animated.View>
          )}

          {isConnected && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-4">
              <View className="rounded-lg bg-secondary p-4 min-h-[60px] justify-center">
                <View className="flex-row items-center gap-3">
                  <GmailIcon size={20} />
                  <Text className="flex-1 text-base font-semibold">
                    {t('kiloclaw.google.gmailNotifications')}
                  </Text>
                  <Button
                    size="sm"
                    variant={gmailEnabled ? 'default' : 'outline'}
                    onPress={handleToggleGmail}
                    disabled={mutations.setGmailNotifications.isPending}
                  >
                    <Text>
                      {gmailEnabled ? t('kiloclaw.google.enabled') : t('kiloclaw.google.disabled')}
                    </Text>
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
                <Text className="text-destructive">{t('kiloclaw.google.disconnect')}</Text>
              </Button>
            </Animated.View>
          )}
        </Animated.View>
      </DetailScreenScrollView>
    </Animated.View>
  );
}

import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Shield, X } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { revokeImageHost, useTrustedImageHosts } from '@/lib/hooks/use-trusted-image-hosts';
import { revokeHost, useTrustedHosts } from '@/lib/hooks/use-trusted-hosts';

function TrustedHostRow({
  host,
  onRevoke,
}: Readonly<{ host: string; onRevoke: (host: string) => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <View className="flex-row items-center justify-between gap-3 rounded-lg bg-secondary p-3">
      <Text className="min-w-0 flex-1 text-sm font-medium" numberOfLines={1}>
        {host}
      </Text>
      <Pressable
        onPress={() => {
          onRevoke(host);
        }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('trustedHosts.revoke', { host })}
        className="min-h-11 min-w-11 shrink-0 items-center justify-center active:opacity-70"
      >
        <X size={16} color={colors.destructive} />
      </Pressable>
    </View>
  );
}

function HostListSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1].map(index => (
        <View key={index} className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="ml-auto h-4 w-4 rounded" />
        </View>
      ))}
    </View>
  );
}

function TrustedImageHostList({
  hosts,
  hasLoaded,
  onRevoke,
}: Readonly<{
  hosts: string[];
  hasLoaded: boolean;
  onRevoke: (host: string) => void;
}>) {
  const { t } = useTranslation();

  if (!hasLoaded) {
    return <HostListSkeleton />;
  }

  if (hosts.length === 0) {
    return (
      <Text className="text-sm text-muted-foreground">{t('trustedHosts.imagesSectionEmpty')}</Text>
    );
  }

  return (
    <View className="gap-3">
      {hosts.map(host => (
        <TrustedHostRow key={host} host={host} onRevoke={onRevoke} />
      ))}
    </View>
  );
}

export function TrustedHostsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { trustedHosts, hasLoaded } = useTrustedHosts();
  const { trustedImageHosts, hasLoaded: imageHostsLoaded } = useTrustedImageHosts();

  const hasNoTrustedHosts = trustedHosts.length === 0 && trustedImageHosts.length === 0;

  // Revoking is destructive and one tap away on a single row, so it confirms
  // first, the way the passkey and device-session removal rows do
  // (apps/mobile/AGENTS.md).
  const confirmRevoke = (host: string, revoke: (host: string) => void, message: string) => {
    Alert.alert(t('trustedHosts.revoke', { host }), message, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('organization.members.revokeConfirm'),
        style: 'destructive',
        onPress: () => {
          revoke(host);
        },
      },
    ]);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('trustedHosts.title')} />
      {hasLoaded && imageHostsLoaded && hasNoTrustedHosts ? (
        <EmptyState
          icon={Shield}
          title={t('trustedHosts.emptyTitle')}
          description={t('trustedHosts.emptyDescription')}
          action={
            <Button
              variant="outline"
              onPress={() => {
                router.back();
              }}
            >
              <Text>{t('trustedHosts.backToPreferences')}</Text>
            </Button>
          }
        />
      ) : (
        <TabScreenScrollView
          className="flex-1"
          contentContainerClassName="gap-3 px-6 pt-4"
          showsVerticalScrollIndicator={false}
        >
          {!hasLoaded ? (
            <HostListSkeleton />
          ) : (
            <>
              {trustedHosts.length > 0 ? (
                <View className="gap-3">
                  {trustedHosts.map(host => (
                    <TrustedHostRow
                      key={host}
                      host={host}
                      onRevoke={revokedHost => {
                        confirmRevoke(revokedHost, revokeHost, t('trustedHosts.revokeMessage'));
                      }}
                    />
                  ))}
                </View>
              ) : null}
              <View className="gap-3">
                <View className="gap-1">
                  <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
                    {t('trustedHosts.imagesSectionTitle')}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {t('trustedHosts.imagesSectionDescription')}
                  </Text>
                </View>
                <TrustedImageHostList
                  hosts={trustedImageHosts}
                  hasLoaded={imageHostsLoaded}
                  onRevoke={host => {
                    confirmRevoke(host, revokeImageHost, t('trustedHosts.revokeImageMessage'));
                  }}
                />
              </View>
            </>
          )}
        </TabScreenScrollView>
      )}
    </View>
  );
}

import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Shield, X } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { revokeHost, useTrustedHosts } from '@/lib/hooks/use-trusted-hosts';

export function TrustedHostsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { trustedHosts, hasLoaded } = useTrustedHosts();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('trustedHosts.title')} />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-3 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {!hasLoaded && (
          <View className="gap-3">
            {[0, 1].map(index => (
              <View key={index} className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="ml-auto h-4 w-4 rounded" />
              </View>
            ))}
          </View>
        )}

        {hasLoaded && trustedHosts.length === 0 && (
          <EmptyState
            icon={Shield}
            placement="top"
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
        )}

        {hasLoaded && trustedHosts.length > 0 && (
          <View className="gap-3">
            {trustedHosts.map(host => (
              <View
                key={host}
                className="flex-row items-center justify-between gap-3 rounded-lg bg-secondary p-3"
              >
                <Text className="min-w-0 flex-1 text-sm font-medium" numberOfLines={1}>
                  {host}
                </Text>
                <Pressable
                  onPress={() => {
                    revokeHost(host);
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('trustedHosts.revoke', { host })}
                  className="min-h-11 shrink-0 items-center justify-center active:opacity-70"
                >
                  <X size={16} color={colors.destructive} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </TabScreenScrollView>
    </View>
  );
}

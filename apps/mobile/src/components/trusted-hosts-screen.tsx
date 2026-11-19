import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Globe, Shield, X } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { revokeImageHost, useTrustedImageHosts } from '@/lib/hooks/use-trusted-image-hosts';
import { revokeHost, useTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';

function TrustedHostRow({
  host,
  onRevoke,
}: Readonly<{ host: string; onRevoke: (host: string) => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <ConfigureRow
      icon={Globe}
      title={host}
      variant="action"
      trailing={
        <IconButton
          accessibilityLabel={t('trustedHosts.revoke', { host })}
          onPress={() => {
            onRevoke(host);
          }}
        >
          <X size={16} color={colors.destructive} />
        </IconButton>
      }
    />
  );
}

function HostListSkeleton() {
  return (
    <RowGroup leadingTile>
      {[0, 1].map(index => (
        <RowSkeleton key={index} tile />
      ))}
    </RowGroup>
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
    return <Text variant="caption">{t('trustedHosts.imagesSectionEmpty')}</Text>;
  }

  return (
    <RowGroup leadingTile>
      {hosts.map(host => (
        <TrustedHostRow key={host} host={host} onRevoke={onRevoke} />
      ))}
    </RowGroup>
  );
}

export function TrustedHostsScreen() {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const { trustedHosts, hasLoaded } = useTrustedHosts();
  const { trustedImageHosts, hasLoaded: imageHostsLoaded } = useTrustedImageHosts();

  const hasNoTrustedHosts = trustedHosts.length === 0 && trustedImageHosts.length === 0;

  // Revoking is destructive and one tap away on a single row, so it confirms
  // first, the way the passkey and device-session removal rows do
  // (apps/mobile/AGENTS.md).
  const confirmRevoke = (host: string, revoke: (host: string) => void, message: string) => {
    confirm({
      title: t('trustedHosts.revoke', { host }),
      message,
      confirmLabel: t('organization.members.revokeConfirm'),
      onConfirm: () => {
        revoke(host);
      },
    });
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('trustedHosts.title')} backFallback={PROFILE_TAB_HREF} />
      {hasLoaded && imageHostsLoaded && hasNoTrustedHosts ? (
        <EmptyState
          icon={Shield}
          title={t('trustedHosts.emptyTitle')}
          description={t('trustedHosts.emptyDescription')}
        />
      ) : (
        <TabScreenScrollView
          className="flex-1"
          contentContainerClassName={SCREEN_BODY_CLASS}
          showsVerticalScrollIndicator={false}
        >
          {!hasLoaded ? (
            <HostListSkeleton />
          ) : (
            <>
              {trustedHosts.length > 0 ? (
                <RowGroup leadingTile>
                  {trustedHosts.map(host => (
                    <TrustedHostRow
                      key={host}
                      host={host}
                      onRevoke={revokedHost => {
                        confirmRevoke(revokedHost, revokeHost, t('trustedHosts.revokeMessage'));
                      }}
                    />
                  ))}
                </RowGroup>
              ) : null}
              <Section label={t('trustedHosts.imagesSectionTitle')}>
                <Text variant="caption">{t('trustedHosts.imagesSectionDescription')}</Text>
                <TrustedImageHostList
                  hosts={trustedImageHosts}
                  hasLoaded={imageHostsLoaded}
                  onRevoke={host => {
                    confirmRevoke(host, revokeImageHost, t('trustedHosts.revokeImageMessage'));
                  }}
                />
              </Section>
            </>
          )}
        </TabScreenScrollView>
      )}

      {dialog}
    </View>
  );
}

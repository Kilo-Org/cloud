import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { hostTarget } from '@/components/ssh/host-target';
import { IconTile } from '@/components/ui/icon-tile';
import { Server } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { type SshHost } from '@/lib/ssh/hosts';

type HostListRowProps = Readonly<{
  host: SshHost;
  /** The stored host this one reaches through, or null when it connects directly. */
  jumpHost: SshHost | null;
  onPress: () => void;
  onLongPress: () => void;
}>;

/** One stored host: its label, the `user@host:port` it opens, and its jump. */
export function HostListRow({ host, jumpHost, onPress, onLongPress }: HostListRowProps) {
  const { t } = useTranslation();
  const target = hostTarget(host);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={t('ssh.hosts.rowActions', { label: host.label, target })}
      className="flex-row items-center gap-3 rounded-lg bg-secondary px-4 py-3 active:opacity-70"
    >
      <IconTile icon={Server} tint={NEUTRAL_TINT} />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {host.label}
        </Text>
        <Text variant="mono" className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          {target}
        </Text>
        {jumpHost === null ? null : (
          <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
            {t('ssh.hosts.viaJump', { label: jumpHost.label })}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

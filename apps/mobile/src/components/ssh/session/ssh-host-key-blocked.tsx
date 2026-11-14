import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { ShieldAlert } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SshHostKeyAwaiting } from '@/lib/ssh/session/types';

type SshHostKeyBlockedProps = Readonly<{
  hostKey: SshHostKeyAwaiting & { readonly knownFingerprintSha256: string };
  /** The host's own name, which the prose names instead of its stored pattern. */
  label: string;
  onOpenKnownHosts: () => void;
  onClose: () => void;
}>;

/**
 * A host that presented a different key than the one the store trusts.
 *
 * There is no Accept here on purpose: the whole value of a trusted key is that
 * a change is a warning, not a dialog to dismiss. The two fingerprints are
 * shown side by side so the person can see whether the server was rebuilt, and
 * the way forward is the known-hosts screen, where the old entry is removed
 * deliberately. Disconnect is the primary action, because the safe answer is
 * the one that leaves: opening the override path is the secondary one.
 */
export function SshHostKeyBlocked({
  hostKey,
  label,
  onOpenKnownHosts,
  onClose,
}: SshHostKeyBlockedProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();

  return (
    <View className="flex-1 gap-4 px-4 pt-6" style={{ paddingBottom: bottom + 24 }}>
      <View className="flex-row items-center gap-2">
        <ShieldAlert size={20} color={colors.destructive} />
        <Text className="text-base font-semibold text-foreground">
          {t('ssh.session.hostKeyChangedTitle')}
        </Text>
      </View>
      <Text className="text-sm text-muted-foreground">
        {t('ssh.session.hostKeyChangedBody', {
          pattern: label,
          algorithm: hostKey.algorithm,
        })}
      </Text>

      <View className="gap-3 rounded-lg border border-danger-tile-border bg-danger-tile-bg p-3">
        <Fingerprint
          label={t('ssh.session.hostKeyTrusted')}
          value={hostKey.knownFingerprintSha256}
        />
        <Fingerprint label={t('ssh.session.hostKeyOffered')} value={hostKey.fingerprintSha256} />
      </View>

      <View className="mt-auto gap-2">
        <Button className={STATE_ACTION_CLASS} onPress={onClose}>
          <Text>{t('ssh.session.disconnect')}</Text>
        </Button>
        <Button variant="outline" className={STATE_ACTION_CLASS} onPress={onOpenKnownHosts}>
          <Text>{t('ssh.session.openKnownHosts')}</Text>
        </Button>
      </View>
    </View>
  );
}

function Fingerprint({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-muted-foreground">{label}</Text>
      <Text variant="mono" className="text-xs text-foreground">
        {value}
      </Text>
    </View>
  );
}

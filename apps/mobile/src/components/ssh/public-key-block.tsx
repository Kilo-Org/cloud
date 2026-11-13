import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { Share, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Copy, Share2 } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SshPublicKeyBlockProps = Readonly<{
  publicKey: string;
  fingerprint: string;
}>;

/** The key a person installs on their server, with the fingerprint they check it by. */
export function SshPublicKeyBlock({ publicKey, fingerprint }: SshPublicKeyBlockProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  async function copy() {
    await Clipboard.setStringAsync(publicKey);
    toast.success(t('ssh.keys.copied'));
  }

  return (
    <View className="gap-2 rounded-md border border-border bg-secondary p-3">
      <Text className="text-xs text-muted-foreground">{t('ssh.keys.fingerprint')}</Text>
      <Text variant="mono" className="text-xs text-foreground">
        {fingerprint}
      </Text>
      <Text className="mt-1 text-xs text-muted-foreground">{t('ssh.keys.publicKey')}</Text>
      <Text variant="mono" className="text-xs text-foreground">
        {publicKey}
      </Text>
      <View className="flex-row gap-2 pt-1">
        <Button variant="outline" size="sm" onPress={() => void copy()}>
          <Copy size={14} color={colors.foreground} />
          <Text>{t('common.copy')}</Text>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onPress={() => {
            void Share.share({ message: publicKey });
          }}
        >
          <Share2 size={14} color={colors.foreground} />
          <Text>{t('ssh.keys.share')}</Text>
        </Button>
      </View>
    </View>
  );
}

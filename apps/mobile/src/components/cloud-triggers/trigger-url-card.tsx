/**
 * The URL an inbound call posts to, with the copy control beside it.
 *
 * It is the only place a trigger's address is shown, so the detail screen
 * renders it above the form: a person who has just created a trigger needs the
 * URL before anything else. A scheduled trigger has no inbound URL, and the
 * screen then renders nothing here.
 */

import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { FormFieldLabel } from '@/components/ui/form-field-label';
import { Copy } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { Text } from '@/components/ui/text';
import { copyWebhookUrl } from '@/lib/cloud-triggers/copy-webhook-url';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function TriggerUrlCard({ url }: Readonly<{ url: string }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="gap-1.5">
      <FormFieldLabel label={t('cloudAgent.triggers.webhookUrl')} />
      <View className="flex-row items-center gap-2">
        <Text variant="mono" className="min-w-0 flex-1 self-start text-xs">
          {url}
        </Text>
        <IconButton
          accessibilityLabel={t('common.copyLink')}
          onPress={() => {
            void copyWebhookUrl(url);
          }}
        >
          <Copy size={16} color={colors.mutedForeground} />
        </IconButton>
      </View>
    </View>
  );
}

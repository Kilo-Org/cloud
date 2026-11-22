/**
 * The URL an inbound call posts to, with the copy control beside it.
 *
 * It is the only place a trigger's address is shown, so the detail screen
 * renders it above the form: a person who has just created a trigger needs the
 * URL before anything else. A scheduled trigger has no inbound URL, and the
 * screen then renders nothing here.
 */

import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { FormFieldLabel } from '@/components/ui/form-field-label';
import { Copy } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { COMPACT_CONTROL_BOX_CLASS, COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { copyWebhookUrl } from '@/lib/cloud-triggers/copy-webhook-url';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

export function TriggerUrlCard({ url }: Readonly<{ url: string }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  // The copy control is the shared compact box, floated over the address's own
  // box so its centre follows the URL block whatever the address wraps to, and
  // it stays out of the column's flow so the pair keeps the field's
  // label-to-value gap. A full-size 48dp icon target does not fit a text-height
  // row: centred on a two-line address it reached 9.9dp above and below the
  // line and overlapped the label above it. The compact box keeps the same
  // reach through `hitSlop`, which adds no frame of its own. The empty cell
  // beside the address covers the control's width, so the address wraps before
  // the control instead of running under it; the cell carries no height, so the
  // address block still sets the line the control centres on.
  return (
    <View className="gap-1.5">
      <FormFieldLabel label={t('cloudAgent.triggers.webhookUrl')} />
      <View>
        <View className="flex-row">
          <Text variant="mono" className="min-w-0 flex-1 text-xs">
            {url}
          </Text>
          <View className="w-14" />
        </View>
        <View className="absolute inset-y-0 end-0 justify-center">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.copyLink')}
            onPress={() => {
              void copyWebhookUrl(url);
            }}
            hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
            className={cn(COMPACT_CONTROL_BOX_CLASS, 'active:opacity-70')}
          >
            <Copy size={16} color={colors.mutedForeground} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

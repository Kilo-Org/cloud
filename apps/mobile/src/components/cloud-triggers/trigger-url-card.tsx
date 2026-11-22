/**
 * The URL an inbound call posts to, with the copy control beside it.
 *
 * It is the only place a trigger's address is shown, so the detail screen
 * renders it above the form: a person who has just created a trigger needs the
 * URL before anything else. A scheduled trigger has no inbound URL, and the
 * screen then renders nothing here.
 *
 * The field itself is the copy control, not the glyph beside the address.
 * React Native confines a touch to every ancestor view's bounds, and this
 * field's value line is only as tall as the address — one line of `text-xs`,
 * or two when the address wraps. A control on that line can never deliver a
 * taller touch target, and one that declares `hitSlop` loses that reach at the
 * line's edge. The block carries the target on its own node instead: the label
 * and the value together take the shared `TOUCH_TARGET_CLASS` floor, so the
 * target grows with the address and nothing out of flow moves the label away
 * from its value or the card away from the section it ends. A shared session
 * link is the same shape (`session-share-active-link.tsx`).
 */

import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { FormFieldLabel } from '@/components/ui/form-field-label';
import { Copy } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { TOUCH_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { i18n } from '@/i18n';
import { copyWebhookUrl } from '@/lib/cloud-triggers/copy-webhook-url';
import { formatList } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

export function TriggerUrlCard({ url }: Readonly<{ url: string }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={formatList([t('common.copyLink'), url], i18n.language)}
      onPress={() => {
        void copyWebhookUrl(url);
      }}
      className={cn('gap-1.5 active:opacity-70', TOUCH_TARGET_CLASS)}
    >
      <FormFieldLabel label={t('cloudAgent.triggers.webhookUrl')} />
      <View className="flex-row">
        <Text variant="mono" className="min-w-0 flex-1 text-xs">
          {url}
        </Text>
        {/* The end band the field has always reserved for the control: 49 dp,
            so the address wraps before the glyph and the glyph centres where
            the base screen painted it. It is decoration inside the pressable,
            not a control of its own. */}
        <View className="w-14 shrink-0 items-center justify-center">
          <Copy size={16} color={colors.mutedForeground} />
        </View>
      </View>
    </Pressable>
  );
}

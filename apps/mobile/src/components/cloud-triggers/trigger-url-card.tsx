/**
 * The URL an inbound call posts to, with the copy control beside it.
 *
 * It is the only place a trigger's address is shown, so the detail screen
 * renders it above the form: a person who has just created a trigger needs the
 * URL before anything else. A scheduled trigger has no inbound URL, and the
 * screen then renders nothing here.
 *
 * The copy control carries `hitSlop` to reach the platform's touch target.
 * React Native delivers a touch only inside the parent view's bounds, so that
 * slop is real only when the parent is at least the platform target on both
 * axes. The control therefore sits in such a host, and the host is in flow, so
 * no part of it overhangs the label above or the row below.
 */

import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { FormFieldLabel } from '@/components/ui/form-field-label';
import { Copy } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  textActionTargetClass,
} from '@/lib/a11y/tap-target';
import { copyWebhookUrl } from '@/lib/cloud-triggers/copy-webhook-url';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

export function TriggerUrlCard({ url }: Readonly<{ url: string }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  // The copy control is the shared compact box, which declares its reach
  // through `hitSlop`. React Native clips that reach at the parent view, so the
  // parent must be at least the platform target on both axes or most of the
  // declared reach never reaches the touch. The host carries that target, the
  // box and its slop sit inside it, and the host is in flow with no negative
  // margin, so nothing here overhangs the label above or the row below.
  return (
    <View className="gap-1.5">
      <FormFieldLabel label={t('cloudAgent.triggers.webhookUrl')} />
      <View className="flex-row items-center gap-2">
        <Text variant="mono" className="min-w-0 flex-1 text-xs">
          {url}
        </Text>
        <View className={cn('shrink-0 items-center justify-center', textActionTargetClass())}>
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

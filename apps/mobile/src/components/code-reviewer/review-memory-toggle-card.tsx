import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';

/**
 * The review-memory switch card. One named control with a 44pt target: the
 * sentence is what a tap moves, and the native Switch carries the name, hint
 * and state. The text cannot be a switch of its own: Android ignores
 * `accessible={false}` on a native switch, so both controls would reach the
 * screen reader, one of them unnamed. PreferenceRow lays out the same shape.
 */
export function ReviewMemoryToggleCard({
  enabled,
  readOnly,
  disabled,
  pending,
  onChange,
}: Readonly<{
  enabled: boolean;
  readOnly: boolean;
  disabled: boolean;
  pending: boolean;
  onChange: (value: boolean) => void;
}>) {
  const { t } = useTranslation();
  return (
    <View className="rounded-lg bg-secondary p-4">
      <View className="flex-row items-center justify-between gap-3">
        <Pressable
          className="min-h-11 min-w-0 flex-1 justify-center active:opacity-70"
          disabled={disabled}
          onPress={() => {
            onChange(!enabled);
          }}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          <Text accessible={false} importantForAccessibility="no" className="text-sm font-medium">
            {t('codeReviewer.reviewMemory.on')}
          </Text>
        </Pressable>
        <Switch
          value={enabled}
          disabled={disabled}
          accessibilityLabel={t('codeReviewer.reviewMemory.title')}
          accessibilityHint={
            readOnly ? t('codeReviewer.reviewMemory.readOnlyDescription') : undefined
          }
          accessibilityState={{ disabled, busy: pending, checked: enabled }}
          onValueChange={onChange}
        />
      </View>
      {readOnly ? (
        <Text variant="muted" className="mt-2 text-xs">
          {t('codeReviewer.reviewMemory.readOnlyDescription')}
        </Text>
      ) : null}
    </View>
  );
}

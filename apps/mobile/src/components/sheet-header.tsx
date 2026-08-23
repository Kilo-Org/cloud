import { useTranslation } from 'react-i18next';
import { I18nManager, Pressable, View } from 'react-native';

import { Share } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function SheetHeader({
  title,
  onDone,
  onCancel,
  doneLabel,
  onShare,
  sharing = false,
  disabled = false,
}: {
  title: string;
  onDone: () => void;
  onCancel?: () => void;
  doneLabel?: string;
  onShare?: () => void;
  sharing?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const resolvedDoneLabel = doneLabel ?? t('common.done');
  // NativeWind may not honor the logical `start-*`/`end-*` utilities in this
  // project, so derive the physical side from the native direction: Cancel and
  // Share stay on the leading edge, Done on the trailing edge.
  const leadingClass = I18nManager.isRTL ? 'right-0' : 'left-0';
  const trailingClass = I18nManager.isRTL ? 'left-0' : 'right-0';
  return (
    // collapsable={false}: react-native-screens lays out a formSheet's scroll
    // view by finding the header at the screen content's subview index 0 — a
    // flattened header breaks that native pass and the list paints over it.
    <View collapsable={false} className="border-b border-border bg-background px-4 pb-3 pt-4">
      <View className="h-11 flex-row items-center justify-center">
        <View className="flex-1 px-24">
          <Text
            className="text-center text-lg font-semibold text-foreground"
            numberOfLines={1}
            accessibilityRole="header"
          >
            {title}
          </Text>
        </View>
        {onShare !== undefined ? (
          <Pressable
            onPress={onShare}
            disabled={sharing || disabled}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.share', { title })}
            accessibilityState={{ disabled: sharing || disabled, busy: sharing }}
            className={`absolute ${leadingClass} px-2 py-2 active:opacity-70 disabled:opacity-50`}
          >
            <Share size={20} color={colors.foreground} />
          </Pressable>
        ) : null}
        {onCancel ? (
          <Pressable
            onPress={onCancel}
            disabled={disabled}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
            className={`absolute ${leadingClass} px-2 py-2 active:opacity-70 disabled:opacity-50`}
          >
            <Text className="text-base font-medium text-foreground">{t('common.cancel')}</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onDone}
          disabled={disabled}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={resolvedDoneLabel}
          className={`absolute ${trailingClass} rounded-full bg-secondary px-4 py-2 active:opacity-70 disabled:opacity-50 will-change-pressable`}
        >
          <Text className="text-base font-medium text-foreground">{resolvedDoneLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

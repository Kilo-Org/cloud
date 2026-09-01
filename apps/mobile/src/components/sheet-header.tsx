import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Share } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function SheetHeader({
  title,
  titleEllipsis = 'tail',
  onDone,
  onCancel,
  doneLabel,
  cancelLabel,
  onShare,
  sharing = false,
  disabled = false,
}: {
  title: string;
  /**
   * 'middle' keeps a filename's extension visible. Android ignores middle
   * truncation past the first line and falls back to tail.
   */
  titleEllipsis?: 'tail' | 'middle';
  onDone: () => void;
  onCancel?: () => void;
  doneLabel?: string;
  /**
   * Overrides the leading control's visible text and accessibility label, so
   * an in-sheet Back is announced as Back, not Cancel.
   */
  cancelLabel?: string;
  onShare?: () => void;
  sharing?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const resolvedDoneLabel = doneLabel ?? t('common.done');
  const resolvedCancelLabel = cancelLabel ?? t('common.cancel');
  // Native row direction and logical margin keep Cancel/Share leading and Done
  // trailing. Do not derive sides from i18n.dir() or the stale I18nManager.isRTL.
  return (
    // collapsable={false}: react-native-screens lays out a formSheet's scroll
    // view by finding the header at the screen content's subview index 0 — a
    // flattened header breaks that native pass and the list paints over it.
    <View collapsable={false} className="border-b border-border bg-background px-4 pb-3 pt-4">
      <View className="min-h-11 flex-row items-center gap-x-3">
        {onShare !== undefined ? (
          <Pressable
            onPress={onShare}
            disabled={sharing || disabled}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.share', { title })}
            accessibilityState={{ disabled: sharing || disabled, busy: sharing }}
            className="min-h-11 min-w-11 shrink-0 items-center justify-center px-2 py-2 active:opacity-70 disabled:opacity-50"
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
            accessibilityLabel={resolvedCancelLabel}
            className="min-h-11 min-w-11 shrink-0 items-center justify-center px-2 py-2 active:opacity-70 disabled:opacity-50"
          >
            <Text className="text-center text-base font-medium text-foreground">
              {resolvedCancelLabel}
            </Text>
          </Pressable>
        ) : null}
        {/* min-w-0 lets the title shrink below its content width so it truncates
            instead of pushing the trailing action out of the row. */}
        <View className="min-w-0 shrink grow">
          <Text
            className="text-lg font-semibold text-foreground"
            numberOfLines={2}
            ellipsizeMode={titleEllipsis}
            accessibilityRole="header"
            accessibilityLabel={title}
          >
            {title}
          </Text>
        </View>
        <Pressable
          onPress={onDone}
          disabled={disabled}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={resolvedDoneLabel}
          className="ms-auto min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full bg-secondary px-4 py-2 active:opacity-70 disabled:opacity-50 will-change-pressable"
        >
          <Text className="text-center text-base font-medium text-foreground">
            {resolvedDoneLabel}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

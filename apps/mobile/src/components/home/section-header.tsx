import { I18nManager, Pressable, View } from 'react-native';

import { EYEBROW_LATIN_DISPLAY, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type SectionHeaderProps = {
  label: string;
  /**
   * Optional link at the row's outer edge (physical right in LTR, physical left
   * in RTL), e.g. "SEE ALL".
   */
  actionLabel?: string;
  onActionPress?: () => void;
};

export function SectionHeader({ label, actionLabel, onActionPress }: Readonly<SectionHeaderProps>) {
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-2">
      <Text variant="eyebrow" className="max-w-full grow">
        {label}
      </Text>
      {actionLabel && onActionPress ? (
        <Pressable
          onPress={onActionPress}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          // The label alone grows, so the row's `justify-between` places this
          // box at the row's end: the physical right in LTR, the physical left
          // in RTL. It must NOT grow too — when both children grew, the row
          // split in half and the action sat at the inner edge of its half (the
          // screen centre in Arabic), so it never reached the margin while the
          // tab bar, cards and rows below were fully mirrored
          // (home-arabic-rtl, home). Never a physical `text-left`/`text-right`:
          // React Native swaps those two under RTL (Android maps
          // `textAlign: 'left'` to `Gravity.RIGHT` when the layout is RTL).
          className="max-w-full shrink-0 flex-row active:opacity-70"
        >
          <Text
            className={cn(
              'shrink font-mono-medium text-[11px] text-primary',
              // LTR-only: the letterspaced capitals break a cursive script's
              // joins, so an RTL action label drops them (home-ar-loading).
              // The class string is the eyebrow variant's, so the two labels
              // cannot drift apart.
              !I18nManager.isRTL && EYEBROW_LATIN_DISPLAY
            )}
          >
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

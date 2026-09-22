import { Pressable, View } from 'react-native';

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
          // The copy sits at the end of the row, so it is placed with the box's
          // own direction (`justify-end` on a `flex-row`) and never with a
          // physical `text-left`/`text-right`: React Native swaps those two
          // under RTL (Android maps `textAlign: 'left'` to `Gravity.RIGHT` when
          // the layout is RTL), which floated the action onto the inner edge of
          // its box instead of the row's end in Arabic.
          className="max-w-full grow flex-row justify-end active:opacity-70"
        >
          <Text
            className={cn(
              'shrink font-mono-medium text-[11px] text-primary',
              // The class string is the eyebrow variant's, so the two labels
              // cannot drift apart. Its `letter-spacing` is neutralized in RTL
              // by `Text`'s style, so the Arabic action label keeps its joins
              // (home-ar-loading).
              EYEBROW_LATIN_DISPLAY
            )}
          >
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

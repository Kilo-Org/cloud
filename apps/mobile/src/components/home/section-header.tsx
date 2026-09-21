import { I18nManager, Pressable, View } from 'react-native';

import { EYEBROW_LATIN_DISPLAY, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type SectionHeaderProps = {
  label: string;
  /** Optional link at the row's outer edge (physical right in LTR, physical left in RTL). */
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
          className="max-w-full grow flex-row justify-end active:opacity-70"
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

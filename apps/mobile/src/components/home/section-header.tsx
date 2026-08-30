import { I18nManager, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type SectionHeaderProps = {
  label: string;
  /** Optional right-aligned link (e.g. "SEE ALL"). */
  actionLabel?: string;
  onActionPress?: () => void;
};

export function SectionHeader({ label, actionLabel, onActionPress }: Readonly<SectionHeaderProps>) {
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-5">
      <Text variant="eyebrow">{label}</Text>
      {actionLabel && onActionPress ? (
        <Pressable
          onPress={onActionPress}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          className="max-w-full grow active:opacity-70"
        >
          <Text
            className={cn(
              'shrink font-mono-medium text-[11px] uppercase tracking-[1.5px] text-primary',
              I18nManager.isRTL ? 'text-left' : 'text-right'
            )}
          >
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

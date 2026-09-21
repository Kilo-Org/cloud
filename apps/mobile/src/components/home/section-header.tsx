import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';

type SectionHeaderProps = {
  label: string;
  /** Optional end-aligned link (e.g. "SEE ALL"). */
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
          className="max-w-full grow items-end active:opacity-70"
        >
          <Text className="shrink font-mono-medium text-[11px] uppercase tracking-[1.5px] text-primary">
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

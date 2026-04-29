import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';

type SectionHeaderProps = {
  label: string;
  /** Optional right-aligned link (e.g. "SEE ALL"). */
  actionLabel?: string;
  onActionPress?: () => void;
};

export function SectionHeader({ label, actionLabel, onActionPress }: Readonly<SectionHeaderProps>) {
  return (
    <View className="flex-row items-center justify-between px-4 pb-2 pt-5">
      <Text variant="eyebrow">{label}</Text>
      {actionLabel && onActionPress ? (
        <Pressable onPress={onActionPress} hitSlop={8} accessibilityLabel={actionLabel}>
          <Text className="font-mono-medium text-[11px] uppercase tracking-[1.5px] text-primary">
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

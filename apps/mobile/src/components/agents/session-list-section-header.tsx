import { View } from 'react-native';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';

type SessionListSectionHeaderProps = {
  title: string;
  count: number;
};

/**
 * Shared "section header + mono count" row used by the Agents list
 * date sections AND the pinned "Active now" tray. Matches the existing
 * `flex-row items-center justify-between bg-background px-[22px] pb-2
 * pt-[18px]` header with `<Eyebrow>` + a mono count
 * `text-[10px] uppercase tracking-[1.5px] text-muted-soft`.
 */
export function SessionListSectionHeader({
  title,
  count,
}: Readonly<SessionListSectionHeaderProps>) {
  return (
    <View className="flex-row items-center justify-between bg-background px-[22px] pb-2 pt-[18px]">
      <Eyebrow>{title}</Eyebrow>
      <Text variant="mono" className="text-[10px] uppercase tracking-[1.5px] text-muted-soft">
        {count}
      </Text>
    </View>
  );
}

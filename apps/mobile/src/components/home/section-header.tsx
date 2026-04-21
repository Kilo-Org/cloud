import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

type SectionHeaderProps = {
  label: string;
  action?: ReactNode;
};

export function SectionHeader({ label, action }: Readonly<SectionHeaderProps>) {
  return (
    <View className="flex-row items-center justify-between px-4">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {label}
      </Text>
      {action}
    </View>
  );
}

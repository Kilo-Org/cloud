import { type LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ConsentRowProps = {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
};

export function ConsentRow({ icon: Icon, title, description }: ConsentRowProps) {
  const colors = useThemeColors();

  return (
    <View className="flex-row gap-3">
      <View className="mt-1 w-6 items-center">
        <Icon size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-foreground">{title}</Text>
        <Text className="mt-0.5 text-sm text-muted-foreground">{description}</Text>
      </View>
    </View>
  );
}

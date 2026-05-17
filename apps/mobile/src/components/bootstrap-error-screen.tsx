import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type BootstrapErrorScreenProps = {
  readonly title: string;
  readonly description: string;
  readonly primaryLabel: string;
  readonly primaryAccessibilityLabel: string;
  readonly onPrimaryPress: () => void;
  readonly secondaryLabel: string;
  readonly secondaryAccessibilityLabel: string;
  readonly onSecondaryPress: () => void;
};

export function BootstrapErrorScreen({
  title,
  description,
  primaryLabel,
  primaryAccessibilityLabel,
  onPrimaryPress,
  secondaryLabel,
  secondaryAccessibilityLabel,
  onSecondaryPress,
}: BootstrapErrorScreenProps) {
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
      <View className="gap-2">
        <Text className="text-center text-lg font-semibold text-foreground">{title}</Text>
        <Text className="text-center text-sm text-muted-foreground">{description}</Text>
      </View>
      <View className="w-full gap-3">
        <Button size="lg" onPress={onPrimaryPress} accessibilityLabel={primaryAccessibilityLabel}>
          <Text>{primaryLabel}</Text>
        </Button>
        <Button
          variant="outline"
          size="lg"
          onPress={onSecondaryPress}
          accessibilityLabel={secondaryAccessibilityLabel}
        >
          <Text>{secondaryLabel}</Text>
        </Button>
      </View>
    </View>
  );
}

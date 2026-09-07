import { View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type BootstrapErrorScreenProps = {
  readonly title: string;
  readonly description: string;
  readonly primaryLabel: string;
  readonly primaryAccessibilityLabel: string;
  readonly onPrimaryPress: () => void;
  /** Shows the primary button's inline spinner and disables it while the
   *  primary action is in flight. The secondary button stays enabled in all
   *  states: it is the escape hatch. */
  readonly primaryLoading?: boolean;
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
  primaryLoading,
  secondaryLabel,
  secondaryAccessibilityLabel,
  onSecondaryPress,
}: BootstrapErrorScreenProps) {
  return (
    <CenteredState className="bg-background">
      <View className="items-center gap-4 px-6">
        <View className="gap-2">
          <Text className="text-center text-lg font-semibold text-foreground">{title}</Text>
          <Text className="text-center text-sm text-muted-foreground">{description}</Text>
        </View>
        <View className="w-full gap-3">
          <Button
            size="lg"
            loading={primaryLoading}
            onPress={onPrimaryPress}
            accessibilityLabel={primaryAccessibilityLabel}
          >
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
    </CenteredState>
  );
}

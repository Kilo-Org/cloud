import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  const { top, bottom } = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={makeContentContainerStyle({ top, bottom })}
        showsVerticalScrollIndicator={false}
      >
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
      </ScrollView>
    </View>
  );
}

type Insets = { readonly top: number; readonly bottom: number };

const VERTICAL_GUTTER = 24;
const HORIZONTAL_GUTTER = 24;
const CONTENT_GAP = 16;

function makeContentContainerStyle({ top, bottom }: Insets) {
  return {
    flexGrow: 1,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    gap: CONTENT_GAP,
    paddingHorizontal: HORIZONTAL_GUTTER,
    paddingTop: top + VERTICAL_GUTTER,
    paddingBottom: bottom + VERTICAL_GUTTER,
  };
}

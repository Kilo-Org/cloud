import { View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/** The screen's primary action, when the surface has one. */
type PrimaryAction = {
  readonly primaryLabel: string;
  readonly primaryAccessibilityLabel: string;
  readonly onPrimaryPress: () => void;
  /** Shows the primary button's inline spinner and disables it while the
   *  primary action is in flight. The secondary button stays enabled in all
   *  states: it is the escape hatch. */
  readonly primaryLoading?: boolean;
};

/** A surface whose only action is the secondary one (the escape hatch). The
 *  primary keys stay declared as absent so a caller building its props from a
 *  shared base object (both shapes spread the same names) still type-checks,
 *  and so no caller silently passes a primary action the screen ignores. */
type NoPrimaryAction = {
  readonly primaryLabel?: undefined;
  readonly primaryAccessibilityLabel?: undefined;
  readonly onPrimaryPress?: undefined;
  readonly primaryLoading?: undefined;
};

/** A third action below the escape hatch, when the surface offers one. */
type TertiaryAction = {
  readonly tertiaryLabel: string;
  readonly tertiaryAccessibilityLabel: string;
  readonly onTertiaryPress: () => void;
};

/** A surface with no third action: the keys are declared as absent for the
 *  same reason as {@link NoPrimaryAction}'s, and the group is all-or-nothing so
 *  no caller passes a label with nothing behind it. */
type NoTertiaryAction = {
  readonly tertiaryLabel?: undefined;
  readonly tertiaryAccessibilityLabel?: undefined;
  readonly onTertiaryPress?: undefined;
};

type BootstrapErrorScreenProps = {
  readonly title: string;
  readonly description: string;
  readonly secondaryLabel: string;
  readonly secondaryAccessibilityLabel: string;
  readonly onSecondaryPress: () => void;
} & (PrimaryAction | NoPrimaryAction) &
  (TertiaryAction | NoTertiaryAction);

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
  tertiaryLabel,
  tertiaryAccessibilityLabel,
  onTertiaryPress,
}: BootstrapErrorScreenProps) {
  return (
    <CenteredState className="bg-background">
      <View className="items-center gap-4 px-6">
        <View className="gap-2">
          <Text className="text-center text-lg font-semibold text-foreground">{title}</Text>
          <Text className="text-center text-sm text-muted-foreground">{description}</Text>
        </View>
        <View className="w-full gap-3">
          {/* Each group narrows on its own label alone: a caller that omits
              every primary prop (a surface with no retry) renders no primary
              row, and one that omits the tertiary props renders no third row. */}
          {primaryLabel !== undefined ? (
            <Button
              size="lg"
              loading={primaryLoading}
              onPress={onPrimaryPress}
              accessibilityLabel={primaryAccessibilityLabel}
            >
              <Text>{primaryLabel}</Text>
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="lg"
            onPress={onSecondaryPress}
            accessibilityLabel={secondaryAccessibilityLabel}
          >
            <Text>{secondaryLabel}</Text>
          </Button>
          {tertiaryLabel !== undefined ? (
            <Button
              variant="outline"
              size="lg"
              onPress={onTertiaryPress}
              accessibilityLabel={tertiaryAccessibilityLabel}
            >
              <Text>{tertiaryLabel}</Text>
            </Button>
          ) : null}
        </View>
      </View>
    </CenteredState>
  );
}

import { Pressable, type StyleProp, type ViewStyle } from 'react-native';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Plus } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** The one floating action size: 56pt. */
export const FAB_SIZE = 56;

/** The page gutter the FAB aligns to on the end edge. */
export const FAB_GUTTER = 14;

/** The gap the FAB keeps above the tab bar. */
export const FAB_MARGIN = 16;

type FabProps = {
  /** The action's full accessible name and the icon's meaning. */
  label: string;
  onPress: () => void;
  /**
   * The frame the screen positions: bottom above the tab bar, the end edge,
   * and the size. Absent it renders in flow, e.g. inside a test tree.
   */
  style?: StyleProp<ViewStyle>;
  /** The action is running; the glyph becomes a spinner and the control is inert. */
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
};

/** The one floating primary action: a 56pt round primary button. */
export function Fab({
  label,
  onPress,
  style,
  busy = false,
  disabled = false,
  testID,
}: Readonly<FabProps>) {
  const colors = useThemeColors();
  const inert = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inert, busy }}
      testID={testID}
      disabled={inert}
      onPress={onPress}
      className="absolute items-center justify-center rounded-full bg-primary shadow-lg shadow-[#00000040] active:opacity-80"
      style={style}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.primaryForeground} />
      ) : (
        <Plus size={24} color={colors.primaryForeground} />
      )}
    </Pressable>
  );
}

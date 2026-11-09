import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { AlertCircle } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const ALERT_ICON_SIZE = 16;

/**
 * The organization plan refusal the new-session form knows before any press.
 * It reads as a settled state of the form rather than a loose paragraph of
 * error ink: an alert icon and the error-tinted surface hold the explanation,
 * the error ink keeps its contrast on that tint in both schemes, and no action
 * is offered because the plan changes outside the app and every provider step
 * on this form would fail for the same organization.
 */
export function NewSessionPlanRefusal({ message }: Readonly<{ message: string }>) {
  const colors = useThemeColors();

  return (
    <View className="mt-5 flex-row items-start gap-2 rounded-lg border border-danger-tile-border bg-danger-tile-bg px-3 py-2.5">
      <View className="pt-0.5">
        <AlertCircle size={ALERT_ICON_SIZE} color={colors.destructive} />
      </View>
      <AccessibleStatus message={message} tone="error" className="min-w-0 shrink text-sm" />
    </View>
  );
}

import { View } from 'react-native';

import { StateAction } from '@/components/empty-state';
import { AlertCircle, CreditCard } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type TrialRefusalAction } from '@/lib/trial-refusal';
import { cn } from '@/lib/utils';

import { PLAN_REFUSAL_SURFACE_CLASS } from './plan-refusal';

const ALERT_ICON_SIZE = 16;

type OrganizationPlanNoticeProps = Readonly<{
  /** The state this block answers for — `Plan required` — already translated. */
  title: string;
  /** The explanation to paint, already translated. */
  message: string;
  /** The step that can end the state, when the surface has one to offer. */
  action?: TrialRefusalAction;
  className?: string;
}>;

/**
 * The plan refusal of `OrganizationPlanRefusal`, titled: a surface paints the
 * state's title above the explanation, so the section reads it as the state it
 * is in rather than as a warning about content that failed to load.
 *
 * The tinted surface, the alert mark and the title carry the refusal; the
 * explanation keeps the muted body ink, which stays readable on that tint in
 * both schemes, so red remains the warning cue of the mark and the title rather
 * than a whole paragraph. The action is the state's one control, so it takes
 * the primary state face: a quiet one would understate the only way out.
 *
 * Its own module, not a second export of `plan-refusal.tsx`: the titled form
 * needs the state action, and that module's chain does not load in the pure
 * (non-mounted) test project, whose suites import the untitled refusal.
 */
export function OrganizationPlanNotice({
  title,
  message,
  action,
  className,
}: OrganizationPlanNoticeProps) {
  const colors = useThemeColors();

  return (
    <View className={cn(PLAN_REFUSAL_SURFACE_CLASS, className)}>
      <View className="min-w-0 flex-row items-start gap-2">
        <View className="pt-0.5">
          <AlertCircle size={ALERT_ICON_SIZE} color={colors.destructive} />
        </View>
        <Text className="min-w-0 flex-1 text-sm font-semibold text-destructive">{title}</Text>
      </View>
      <Text variant="muted" className="mt-1.5 text-sm text-ink2">
        {message}
      </Text>
      {action ? (
        <View className="items-start pt-3">
          <StateAction
            label={action.label}
            icon={CreditCard}
            onPress={() => {
              action.onPress();
            }}
            emphasis="primary"
          />
        </View>
      ) : null}
    </View>
  );
}

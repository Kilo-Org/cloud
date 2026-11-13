import { Pressable, View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { AlertCircle } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { UNDER_COPY_ACTION_BOX_CLASS, UNDER_COPY_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const ALERT_ICON_SIZE = 16;

type OrganizationPlanRefusalProps = Readonly<{
  /** The explanation to paint, already translated. */
  message: string;
  /**
   * The step outside the app that can end the state — the organization hub
   * offers the web billing page to the roles that can change the plan. A
   * surface whose own steps would all fail for the same organization (the
   * new-session form) omits it.
   */
  action?: { label: string; onPress: () => void };
  className?: string;
}>;

/**
 * The organization plan refusal, in every surface that has to state it. An
 * alert icon and the error-tinted surface hold the explanation, the error ink
 * keeps its contrast on that tint in both schemes, and the caller decides
 * whether an action belongs beside it and how much room it takes above itself.
 * The action wears that same ink with an underline: the brand primary is
 * off-palette on this surface, and it reads as the action by decoration
 * instead of by hue.
 *
 * The block pads the same on both vertical edges, so the action cannot add its
 * own box slack below the last line: it renders the under-copy box, which
 * cancels that slack in layout and keeps its target in `hitSlop`, and it sits
 * one related-item gap under the copy. A block without an action keeps the same
 * box.
 */
export function OrganizationPlanRefusal({
  message,
  action,
  className,
}: OrganizationPlanRefusalProps) {
  const colors = useThemeColors();

  return (
    <View
      className={cn(
        'flex-row items-start gap-2 rounded-lg border border-danger-tile-border bg-danger-tile-bg px-3 py-2.5',
        className
      )}
    >
      <View className="pt-0.5">
        <AlertCircle size={ALERT_ICON_SIZE} color={colors.destructive} />
      </View>
      {/* The message takes the row's remaining width instead of shrinking to
          its longest line: a short sentence would otherwise leave the free
          space on one side only, and a right-to-left layout puts that space on
          the opposite edge from a left-to-right one. */}
      <View className="min-w-0 flex-1 gap-2">
        <AccessibleStatus message={message} tone="error" className="text-sm" />
        {action ? (
          <Pressable
            onPress={() => {
              action.onPress();
            }}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            hitSlop={UNDER_COPY_ACTION_HIT_SLOP}
            className={cn(
              'justify-center self-start rounded-md active:opacity-70',
              UNDER_COPY_ACTION_BOX_CLASS
            )}
          >
            <Text className="text-sm font-semibold text-destructive underline">{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

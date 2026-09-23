// Resolve / unresolve toggle for a review thread's header.
//
// Split out of `discussion-thread.tsx` so the card keeps its own line budget:
// the control is self-contained (label, frame, compact visual) and the card
// only wires its resolved/disabled/onPress inputs.

import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Check } from '@/components/ui/icons';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/touch-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ResolveToggleProps = {
  readonly resolved: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
};

export function ResolveToggle({ resolved, disabled, onPress }: Readonly<ResolveToggleProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        resolved ? t('prReview.discussion.unresolveThread') : t('prReview.discussion.resolveThread')
      }
      onPress={onPress}
      disabled={disabled}
      // The frame is the tap target the size audit measures (38.5pt on
      // device) and the header row grows to hold it, so the whole frame is
      // hittable; the 3pt slop reaches the 44pt minimum.
      hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
      className="h-11 w-11 items-center justify-center active:opacity-70"
    >
      {/* The visible circle stays compact (explicit px, because NativeWind's
          14pt rem renders `h-7` at 24.5pt): DESIGN.md keeps the target, not the
          visual, at 44pt. */}
      <View className="h-[28px] w-[28px] items-center justify-center rounded-full border border-border bg-card">
        <Check size={14} color={resolved ? colors.good : colors.mutedForeground} />
      </View>
    </Pressable>
  );
}

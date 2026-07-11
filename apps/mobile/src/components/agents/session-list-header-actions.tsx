import { Plus, SlidersHorizontal } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SessionListHeaderActionsProps = {
  hasActiveFilter: boolean;
  /** Hides the header "New session" button — the empty-state CTA is the only
   * creation affordance while there are no sessions yet. */
  showNewSession: boolean;
  onNewSession: () => void;
  onOpenFilters: () => void;
};

export function SessionListHeaderActions({
  hasActiveFilter,
  showNewSession,
  onNewSession,
  onOpenFilters,
}: Readonly<SessionListHeaderActionsProps>) {
  const colors = useThemeColors();

  return (
    <View className="flex-row items-center gap-4">
      {showNewSession ? (
        <Pressable
          onPress={onNewSession}
          // right slop capped so the expanded targets don't overlap inside the
          // 16px gap; left slop makes up the difference to a 44pt-wide target
          hitSlop={{ top: 11, bottom: 11, left: 14, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="New session"
          className="active:opacity-70"
        >
          <Plus size={22} color={colors.foreground} />
        </Pressable>
      ) : null}
      <Pressable
        onPress={onOpenFilters}
        // left slop capped against the 16px gap, right slop reaches 44pt wide
        hitSlop={{ top: 12, bottom: 12, left: 8, right: 16 }}
        accessibilityRole="button"
        accessibilityLabel="Filter sessions"
        className="active:opacity-70"
      >
        <SlidersHorizontal
          size={20}
          color={hasActiveFilter ? colors.foreground : colors.mutedForeground}
        />
      </Pressable>
    </View>
  );
}

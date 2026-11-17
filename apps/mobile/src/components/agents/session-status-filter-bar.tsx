import { X } from '@/components/ui/icons';
import { type GlanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { statusFilterLabelKey } from '@/components/agents/live-session-status-filter';
import { SessionStatusIcon } from '@/components/ui/session-status-icon';
import { Text } from '@/components/ui/text';
import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
} from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

// The clear control's left slop is capped at the row's `gap-2` (7pt at the
// app's 14pt rem) so its touch region meets the count instead of covering it;
// the shared box plus the shared slop carries the reach on every other side.
const CLEAR_HIT_SLOP = {
  top: COMPACT_CONTROL_HIT_SLOP_DP,
  bottom: COMPACT_CONTROL_HIT_SLOP_DP,
  right: COMPACT_CONTROL_HIT_SLOP_DP,
  left: 7,
};

type SessionStatusFilterBarProps = {
  kind: GlanceableStatusKind;
  count: number;
  onClear: () => void;
};

/**
 * The active status filter on the Agents live list: the state the Home `Live
 * now` card narrowed the list to, the number of live sessions it covers, and a
 * control that clears the filter. It is drawn only while the filter is active,
 * so the list never hides why a status is missing.
 */
export function SessionStatusFilterBar({
  kind,
  count,
  onClear,
}: Readonly<SessionStatusFilterBarProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  // Landscape side insets keep the chip clear of the sensor housing; portrait
  // insets are 0, keeping the fixed gutter unchanged.
  const { left, right } = useSafeAreaInsets();
  const margins = useMemo(
    () => ({ marginLeft: left, marginRight: right }),
    [left, right]
  );

  return (
    <View style={margins} className="flex-row items-center gap-2 px-4 pb-1.5">
      <SessionStatusIcon kind={kind} />
      <Text className="text-sm text-foreground" numberOfLines={1}>
        {t(statusFilterLabelKey(kind))}
      </Text>
      <Text className="text-sm text-muted-foreground">{count}</Text>
      <Pressable
        onPress={onClear}
        accessibilityRole="button"
        accessibilityLabel={t('common.clearFilters')}
        hitSlop={CLEAR_HIT_SLOP}
        testID="session-status-filter-clear"
        className={cn(COMPACT_CONTROL_BOX_CLASS, 'ml-auto active:opacity-70')}
      >
        <X size={16} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

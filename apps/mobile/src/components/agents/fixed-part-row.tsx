import { type LucideIcon, XCircle } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTranslatedToolSummary } from '@/lib/tool-summary-translation/use-translated-tool-summary';
import { cn } from '@/lib/utils';

import { useToolSummaryItemId } from './tool-summary-translation-scope';

import { useMessageLongPress } from './message-long-press-context';

type FixedPartRowProps = {
  /** Tool icon, shown in the completed slot. Never passed for reasoning rows. */
  icon?: LucideIcon;
  /** Primary text: `display.subtitle ?? display.title`. */
  label: string;
  /** 'text' for tools, 'eyebrow' for reasoning. */
  labelKind?: 'text' | 'eyebrow';
  badge?: string;
  /** Absent for reasoning rows. */
  status?: 'pending' | 'running' | 'completed' | 'error';
  /** 'solid' tools, 'dashed' reasoning. */
  variant?: 'solid' | 'dashed';
  /**
   * A control-sized row instead of a full-width one. Reasoning rows use it: a
   * folded thought is a small affordance beside the answer, not a line of the
   * transcript, and a full-width row for every one of them read as noise above
   * short answers. The row keeps a 44pt iOS / 48dp Android tap area through its
   * own minimum height plus hit slop. Tool rows keep the default.
   */
  compact?: boolean;
  /** Presence makes the row pressable and adds the chevron and details hint. */
  onPress?: () => void;
  /**
   * Whether the label carries tool content worth translating. Defaults to true;
   * tool cards pass the display projection's `translatable` so a label that is
   * already-localized UI copy or a raw tool id is never sent to the gateway.
   */
  translatable?: boolean;
  accessibilityLabel: string;
};

/**
 * Shared fixed-height row chrome for non-message transcript parts. Stateless
 * and single-line: the row never expands inline and never changes height from
 * streaming state transitions. The loading spinner is pinned to the status
 * icons' square, so the leading slot contributes the same height in every
 * status. A completed row without an `icon` renders no leading element (a
 * valid no-op, never an undefined component).
 *
 * A long press opens the message-details sheet through
 * `MessageLongPressContext`: the row's tap responder would otherwise swallow
 * the bubble's long-press contract on the row's surface. When no handler is
 * mounted (rows outside a message bubble) the pressable keeps tap-only
 * behavior; a disabled row already falls through to the bubble pressable.
 */
export function FixedPartRow({
  icon: Icon,
  label,
  labelKind = 'text',
  badge,
  status,
  variant = 'solid',
  compact = false,
  onPress,
  translatable = true,
  accessibilityLabel,
}: Readonly<FixedPartRowProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const messageLongPress = useMessageLongPress();
  const itemId = useToolSummaryItemId();
  const shownLabel = useTranslatedToolSummary(label, translatable, itemId ?? undefined);
  // Keep the spoken summary in step with the visible one without a second
  // translation request: only the embedded label changes.
  const shownAccessibilityLabel =
    label !== '' && shownLabel !== label
      ? accessibilityLabel.split(label).join(shownLabel)
      : accessibilityLabel;

  return (
    <View
      className={cn(
        'overflow-hidden border border-border',
        compact ? 'self-start rounded-full' : 'rounded-lg',
        variant === 'dashed' && 'border-dashed'
      )}
    >
      <Pressable
        className={cn(
          'flex-row items-center active:bg-secondary',
          compact ? 'min-h-[32px] gap-1.5 px-2.5' : 'gap-2 px-3 py-2'
        )}
        // The compact row is control-height, so its reach comes from the shared
        // compact hit slop: it reaches the 44pt / 48dp minimum either way.
        hitSlop={compact ? COMPACT_CONTROL_HIT_SLOP_DP : undefined}
        onPress={onPress}
        onLongPress={messageLongPress ?? undefined}
        disabled={!onPress}
        accessibilityRole="button"
        accessibilityLabel={shownAccessibilityLabel}
        accessibilityHint={onPress ? t('agentChat.partDetail.showDetails') : undefined}
        accessibilityState={{ disabled: !onPress }}
      >
        {status === 'pending' || status === 'running' ? (
          // RN's small spinner is 20x20 while the status icons are 16x16, so
          // the row grew ~2.5dp while a tool ran and snapped back when it
          // resolved (iOS and Android alike). Pin the spinner to the icon's
          // square: the leading slot is then identical in every status and the
          // label, not the spinner, sizes the row.
          <View className="size-[16px] items-center justify-center">
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          </View>
        ) : null}
        {status === 'error' ? <XCircle size={16} color={colors.destructive} /> : null}
        {status === 'completed' && Icon ? <Icon size={16} color={colors.mutedForeground} /> : null}

        {/* Baseline, not center: the label is text-sm and the badge text-xs, so
            centering the line boxes drops the badge below the label. */}
        <View className="flex-1 flex-row items-baseline gap-1.5">
          {labelKind === 'eyebrow' ? (
            <Eyebrow className="shrink" numberOfLines={1}>
              {shownLabel}
            </Eyebrow>
          ) : (
            <Text className="shrink text-sm text-muted-foreground" numberOfLines={1}>
              {shownLabel}
            </Text>
          )}
          {badge ? (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {badge}
            </Text>
          ) : null}
        </View>

        {onPress ? <DirectionalChevronRight size={14} color={colors.mutedForeground} /> : null}
      </Pressable>
    </View>
  );
}

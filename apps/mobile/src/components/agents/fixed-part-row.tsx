import { type LucideIcon, XCircle } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTranslatedToolSummary } from '@/lib/tool-summary-translation/use-translated-tool-summary';

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
 * streaming state transitions. A completed row without an `icon` renders no
 * leading element (a valid no-op, never an undefined component).
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
      className={
        variant === 'dashed'
          ? 'overflow-hidden rounded-lg border border-dashed border-border'
          : 'overflow-hidden rounded-lg border border-border'
      }
    >
      <Pressable
        className="flex-row items-center gap-2 px-3 py-2 active:bg-secondary"
        onPress={onPress}
        onLongPress={messageLongPress ?? undefined}
        disabled={!onPress}
        accessibilityRole="button"
        accessibilityLabel={shownAccessibilityLabel}
        accessibilityHint={onPress ? t('agentChat.partDetail.showDetails') : undefined}
        accessibilityState={{ disabled: !onPress }}
      >
        {status === 'pending' || status === 'running' ? (
          <ActivityIndicator size="small" color={colors.mutedForeground} />
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

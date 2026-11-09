import { AlertTriangle, type LucideIcon, XCircle } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useToolSummaryTranslation } from '@/lib/tool-summary-translation/use-translated-tool-summary';
import { useToolSummaryItemId } from './tool-summary-translation-scope';
import { cn } from '@/lib/utils';

import { useMessageLongPress } from './message-long-press-context';

/**
 * The localized translation-failure indicator at the row's end: a text badge,
 * or an icon-only glyph for assembled labels whose single line must not lose
 * width to the badge text. The spoken failure state is carried by the row's
 * `accessibilityLabel` — this indicator sits inside the accessible Pressable,
 * whose descendants are not exposed to screen readers on iOS.
 */
function TranslationFailureIndicator({ iconOnly }: { iconOnly: boolean }) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  if (iconOnly) {
    return (
      <View
        className="shrink-0"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <AlertTriangle size={12} color={colors.mutedForeground} />
      </View>
    );
  }
  return (
    <Text className="text-xs text-muted-foreground" numberOfLines={1}>
      {t('agentChat.toolCard.translationFailed')}
    </Text>
  );
}

type FixedPartRowProps = {
  /** Tool icon, shown in the completed slot. Never passed for reasoning rows. */
  icon?: LucideIcon;
  /** Primary text: `display.subtitle ?? display.title`. */
  label: string;
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
  /**
   * Render the translation-failure indicator as an icon-only glyph with a
   * localized accessibility label instead of a text badge. For assembled
   * labels (the condensed tool-run row) whose single line must not lose width
   * to the badge text.
   */
  failureIcon?: boolean;
  /**
   * Overrides the row's own translation-failure state. The condensed tool-run
   * row translates its last summary outside the label, so it passes that
   * translation's exhaustion here; `translatable={false}` on the assembled
   * label would otherwise always read as resolved.
   */
  translationFailed?: boolean;
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
  badge,
  status,
  variant = 'solid',
  onPress,
  translatable = true,
  failureIcon = false,
  translationFailed,
  accessibilityLabel,
}: Readonly<FixedPartRowProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const messageLongPress = useMessageLongPress();
  const itemId = useToolSummaryItemId();
  const { text: shownLabel, failed: ownFailed } = useToolSummaryTranslation(
    label,
    // Outside a tool-summary scope (no part id) the label is never translated:
    // every unkeyed call with the same text would share one cache entry.
    translatable && itemId !== null,
    itemId ?? undefined
  );
  const failed = ownFailed || translationFailed === true;
  // Keep the spoken summary in step with the visible one without a second
  // translation request: only the embedded label changes.
  const baseAccessibilityLabel =
    label !== '' && shownLabel !== label
      ? accessibilityLabel.split(label).join(shownLabel)
      : accessibilityLabel;
  // The failure indicator sits inside this accessible Pressable, and an
  // accessible container does not expose its descendants on iOS
  // (message-bubble-a11y), so its label would never be announced. The failure
  // copy is folded into the row's spoken label instead, for both variants.
  const shownAccessibilityLabel = failed
    ? `${baseAccessibilityLabel}, ${t('agentChat.toolCard.translationFailed')}`
    : baseAccessibilityLabel;

  return (
    <View
      className={cn(
        'overflow-hidden rounded-lg border border-border',
        variant === 'dashed' && 'border-dashed'
      )}
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
          <Text className="shrink text-sm text-muted-foreground" numberOfLines={1}>
            {shownLabel}
          </Text>
          {badge ? (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {badge}
            </Text>
          ) : null}
          {failed ? <TranslationFailureIndicator iconOnly={failureIcon} /> : null}
        </View>

        {onPress ? <DirectionalChevronRight size={14} color={colors.mutedForeground} /> : null}
      </Pressable>
    </View>
  );
}

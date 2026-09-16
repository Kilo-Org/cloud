import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  MinusCircle,
  XCircle,
} from '@/components/ui/icons';
import { SpinningIcon } from '@/components/ui/spinning-icon';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** The four rollup statuses the checks card summarises, in summary order. */
export type PrReviewChecksStatus = 'success' | 'failure' | 'pending' | 'skipped';

const STATUS_ICON = {
  success: CheckCircle2,
  failure: XCircle,
  pending: Loader2,
  skipped: MinusCircle,
} satisfies Record<PrReviewChecksStatus, typeof CheckCircle2>;

const STATUS_COLOR = {
  success: 'good',
  failure: 'destructive',
  pending: 'mutedForeground',
  skipped: 'mutedForeground',
} satisfies Record<PrReviewChecksStatus, keyof ReturnType<typeof useThemeColors>>;

// Reuse the four status labels the rollup line already shipped, so a reader
// meets one vocabulary (`{{displayCount}} passed`, not a second one).
const STATUS_LABEL_KEY = {
  success: 'prReview.checks.passed',
  failure: 'prReview.checks.failed',
  pending: 'prReview.checks.pending',
  skipped: 'prReview.checks.skipped',
} satisfies Record<PrReviewChecksStatus, string>;

type PrReviewChecksStatusRowProps = {
  readonly status: PrReviewChecksStatus;
  /** How many checks this row counts; must match the expanded children. */
  readonly count: number;
  /** Hairline between two group rows in the card, omitted on the last one. */
  readonly showSeparator: boolean;
  /** The checks this row counts, rendered with the page's existing detail. */
  readonly children: ReactNode;
};

/**
 * One collapsed-by-default status group: a header row (icon, count label,
 * chevron) that expands to the checks it counts. The state lives here, not in
 * the section, so the section gains no hook after its early returns.
 */
export function PrReviewChecksStatusRow({
  status,
  count,
  showSeparator,
  children,
}: Readonly<PrReviewChecksStatusRowProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const Icon = STATUS_ICON[status];
  const iconColor = colors[STATUS_COLOR[status]];
  const label = t(STATUS_LABEL_KEY[status], {
    // count lets a locale that inflects select its own form; displayCount is
    // the formatted total.
    count,
    displayCount: formatNumber(count, i18n.language),
  });
  const Chevron = expanded ? ChevronUp : ChevronDown;

  return (
    <View>
      <Pressable
        className="min-h-11 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
        onPress={() => {
          setExpanded(current => !current);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={label}
      >
        <SpinningIcon icon={Icon} size={16} color={iconColor} spinning={status === 'pending'} />
        <Text className="flex-1 text-sm font-medium" numberOfLines={1}>
          {label}
        </Text>
        <Chevron size={16} color={colors.mutedForeground} />
      </Pressable>
      {/* The layout wrapper stays mounted so the fading block's own exit
          animation can play; the card grows and the rows below slide. */}
      <Animated.View layout={LinearTransition.duration(200)}>
        {expanded ? (
          <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(150)}>
            {children}
          </Animated.View>
        ) : null}
      </Animated.View>
      {showSeparator ? <View className="border-b-[0.5px] border-hair-soft" /> : null}
    </View>
  );
}

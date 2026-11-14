import Svg, { Rect } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { formatCalendarDate } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type UsageBarChartProps = {
  /** One bucket per point, oldest first, with the metric's own unit. */
  points: readonly { datetime: string; value: number }[];
  /** Names what the bars measure; the caption under them stays readable without it. */
  accessibilityLabel: string;
};

const PLOT_HEIGHT = 120;
/**
 * A bar whose value rounds to nothing still has to be visible: 1.5 units of the
 * 100-unit plot is about two device pixels at the standard height.
 */
const MIN_VISIBLE_HEIGHT = 1.5;

/**
 * Daily bars over the selected window, drawn in a fixed 100x100 view box that
 * stretches to the row — no measurement pass, so the chart paints on its first
 * frame and keeps its height through rotation.
 */
export function UsageBarChart({ points, accessibilityLabel }: Readonly<UsageBarChartProps>) {
  const colors = useThemeColors();
  const { i18n } = useTranslation();
  let peak = 0;
  for (const point of points) {
    peak = Math.max(peak, point.value);
  }
  const step = 100 / Math.max(points.length, 1);
  const barWidth = step * 0.64;
  const first = points[0]?.datetime;
  const last = points.at(-1)?.datetime;

  return (
    <View className="gap-2">
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
        className="rounded-lg bg-secondary p-3"
      >
        <Svg
          width="100%"
          height={PLOT_HEIGHT}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          {points.map((point, index) => {
            // A zero has no bar: a visible stub would claim usage that did not
            // happen.
            if (point.value <= 0) {
              return null;
            }
            const height = peak > 0 ? Math.max((point.value / peak) * 100, MIN_VISIBLE_HEIGHT) : 0;
            return (
              <Rect
                key={point.datetime}
                x={index * step + (step - barWidth) / 2}
                y={100 - height}
                width={barWidth}
                height={height}
                fill={colors.primary}
              />
            );
          })}
          <Rect x={0} y={99.6} width={100} height={0.4} fill={colors.ringTrack} />
        </Svg>
      </View>
      {first != null && (
        <View className="flex-row justify-between">
          <Text className="text-xs text-muted-foreground">
            {formatCalendarDate(first, i18n.language)}
          </Text>
          {last != null && last !== first && (
            <Text className="text-xs text-muted-foreground">
              {formatCalendarDate(last, i18n.language)}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

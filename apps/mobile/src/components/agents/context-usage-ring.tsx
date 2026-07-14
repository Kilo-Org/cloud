import Svg, { Circle } from 'react-native-svg';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { type ContextTone, getIndeterminateArcFraction } from './context-usage-display';

type ContextUsageRingProps = {
  size?: number;
  strokeWidth?: number;
  /** Clamped [0,1] arc length. Undefined renders a stable partial neutral arc. */
  arcFraction: number | undefined;
  tone: ContextTone;
  testID?: string;
};

const DEFAULT_SIZE = 28;
const DEFAULT_STROKE = 3;

const TONE_COLORS: Record<ContextTone, keyof ReturnType<typeof useThemeColors>> = {
  destructive: 'destructive',
  warning: 'warn',
  primary: 'primary',
  neutral: 'mutedForeground',
};

function toneColor(tone: ContextTone, colors: ReturnType<typeof useThemeColors>): string {
  return colors[TONE_COLORS[tone]];
}

export function ContextUsageRing({
  size = DEFAULT_SIZE,
  strokeWidth = DEFAULT_STROKE,
  arcFraction,
  tone,
  testID,
}: Readonly<ContextUsageRingProps>) {
  const colors = useThemeColors();
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const trackColor = colors.hairSoft;
  const arcColor = toneColor(tone, colors);
  // Undefined percentage → indeterminate: a stable partial neutral arc so the
  // visual is clearly "we don't know", not a broken empty ring.
  const effectiveFraction = arcFraction ?? getIndeterminateArcFraction();
  const dashLength = Math.max(0, Math.min(1, effectiveFraction)) * circumference;
  const dashGap = circumference - dashLength;
  const rotation = -90;

  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      accessibilityElementsHidden
      importantForAccessibility="no"
      testID={testID}
    >
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={trackColor}
        strokeWidth={strokeWidth}
        fill="none"
      />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={arcColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${dashLength} ${dashGap}`}
        fill="none"
        transform={`rotate(${rotation} ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}

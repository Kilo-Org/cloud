import Svg, { Circle } from 'react-native-svg';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { type ContextTone } from './context-usage-display';

type ContextUsageRingProps = {
  size?: number;
  strokeWidth?: number;
  /** Arc share in [0,1]. Undefined (unknown capacity) renders the track alone. */
  arcFraction: number | undefined;
  tone: ContextTone;
  testID?: string;
};

const DEFAULT_SIZE = 28;
const DEFAULT_STROKE = 3;

const TONE_COLORS = {
  destructive: 'destructive',
  warning: 'warn',
  primary: 'primary',
  neutral: 'mutedForeground',
} satisfies Record<ContextTone, keyof ReturnType<typeof useThemeColors>>;

function toneColor(tone: ContextTone, colors: ReturnType<typeof useThemeColors>): string {
  return colors[TONE_COLORS[tone]];
}

/** The arc share in [0,1], or undefined when the fraction is not a real number. */
function getClampedFraction(arcFraction: number | undefined): number | undefined {
  if (arcFraction === undefined || !Number.isFinite(arcFraction)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, arcFraction));
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
  const trackColor = colors.ringTrack;
  const arcColor = toneColor(tone, colors);
  // The track always marks that the ring exists. The arc appears only for a
  // known, non-zero share: undefined capacity and a settled zero both read as
  // "nothing to show", not as work in progress.
  const fraction = getClampedFraction(arcFraction);
  const dashLength = fraction === undefined ? 0 : fraction * circumference;
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
      {fraction === undefined || fraction === 0 ? null : (
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
      )}
    </Svg>
  );
}

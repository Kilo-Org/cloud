/**
 * Lightweight SVG sparkline — no charting library needed.
 * Renders an area chart from an array of numbers (one per bucket).
 */

type SparklineProps = {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
};

export function Sparkline({ data, width = 120, height = 24, className }: SparklineProps) {
  if (data.length === 0) return null;

  const max = Math.max(...data, 1); // avoid division by zero
  const step = width / (data.length - 1 || 1);

  const points = data.map((v, i) => ({
    x: i * step,
    y: height - (v / max) * height,
  }));

  // Build SVG path for the line
  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');

  // Build SVG path for the filled area (line + close along bottom)
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="sparkline-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(95% 0.15 108)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="oklch(95% 0.15 108)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#sparkline-grad)" />
      <path
        d={linePath}
        fill="none"
        stroke="oklch(95% 0.15 108)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

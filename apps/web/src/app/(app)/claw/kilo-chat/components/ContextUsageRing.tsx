'use client';

type ContextUsageRingProps = {
  contextTokens: number;
  contextWindow: number;
};

const SIZE = 18;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function strokeColorClass(pct: number): string {
  if (pct >= 80) return 'text-red-500';
  if (pct >= 50) return 'text-amber-500';
  return 'text-muted-foreground';
}

export function ContextUsageRing({ contextTokens, contextWindow }: ContextUsageRingProps) {
  if (!contextWindow || contextWindow <= 0) return null;

  const rawPct = (contextTokens / contextWindow) * 100;
  const pct = Math.max(0, Math.min(100, rawPct));
  const dashOffset = CIRCUMFERENCE * (1 - pct / 100);
  const tooltip = `${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`;

  return (
    <div className="flex items-center gap-1.5" title={tooltip}>
      <svg width={SIZE} height={SIZE} className={strokeColorClass(pct)} aria-hidden>
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          className="stroke-muted-foreground/20"
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      <span className="text-muted-foreground text-xs tabular-nums">{Math.round(pct)}%</span>
    </div>
  );
}

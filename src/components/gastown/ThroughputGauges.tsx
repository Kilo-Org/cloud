'use client';

import { useMemo } from 'react';
import { motion } from 'motion/react';
import { Zap, DollarSign, Bot, Fuel, FileCode } from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────

type ThroughputData = {
  tokensPerSec: number;
  costPerSec: number;
  activeAgents: number;
  totalAgents: number;
  locAdditions: number;
  locDeletions: number;
};

type GasTankData = {
  balanceDollars: number | null;
  costPerSec: number;
};

type ThroughputGaugesProps = {
  throughput: ThroughputData | null;
  gasTank?: GasTankData;
};

// ── Radial Gauge ─────────────────────────────────────────────────────

function RadialGauge({
  value,
  max,
  label,
  unit,
  icon,
  color,
  formatValue,
}: {
  value: number;
  max: number;
  label: string;
  unit: string;
  icon: React.ReactNode;
  color: string;
  formatValue?: (v: number) => string;
}) {
  const ratio = max > 0 ? Math.min(value / max, 1) : 0;
  // Semi-circle arc: 180 degrees
  const r = 32;
  const cx = 40;
  const cy = 40;
  const circumference = Math.PI * r; // half circle
  const dashOffset = circumference * (1 - ratio);

  const display = formatValue ? formatValue(value) : value.toFixed(1);

  return (
    <div className="flex flex-col items-center gap-1 px-4 py-3">
      <div className={`flex items-center gap-1 ${color}`}>
        {icon}
        <span className="text-[10px] font-medium tracking-wide uppercase opacity-70">{label}</span>
      </div>
      <div className="relative h-[48px] w-[80px]">
        <svg viewBox="0 0 80 48" className="h-full w-full">
          {/* Background arc */}
          <path
            d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            fill="none"
            stroke="oklch(1 0 0 / 0.08)"
            strokeWidth="5"
            strokeLinecap="round"
          />
          {/* Value arc */}
          <path
            d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${circumference}`}
            strokeDashoffset={`${dashOffset}`}
            className={color}
            style={{ transition: 'stroke-dashoffset 0.6s ease-out' }}
          />
        </svg>
        <div className="absolute inset-x-0 bottom-0 text-center">
          <motion.span
            key={display}
            initial={{ opacity: 0.4, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            className="font-mono text-lg font-semibold text-white/85"
          >
            {display}
          </motion.span>
        </div>
      </div>
      <span className="text-[9px] text-white/30">{unit}</span>
    </div>
  );
}

// ── Gas Tank Gauge ──────────────────────────────────────────────────

function GasTankGauge({ balanceDollars, costPerSec }: GasTankData) {
  const fill = balanceDollars ?? 0;
  // Normalize: $100 = full. Adjust as needed.
  const maxBalance = 100;
  const ratio = Math.min(Math.max(fill / maxBalance, 0), 1);

  // Color transitions: green > yellow > red
  const gaugeColor =
    ratio > 0.5 ? 'text-emerald-400' : ratio > 0.2 ? 'text-amber-400' : 'text-red-400';

  const bgColor =
    ratio > 0.5 ? 'bg-emerald-400/20' : ratio > 0.2 ? 'bg-amber-400/20' : 'bg-red-400/20';

  const fillColor = ratio > 0.5 ? 'bg-emerald-400' : ratio > 0.2 ? 'bg-amber-400' : 'bg-red-400';

  // Time remaining estimate using rolling cost rate
  const timeRemaining = useMemo(() => {
    if (costPerSec <= 0 || balanceDollars === null || balanceDollars <= 0) return null;
    const costDollarsPerSec = costPerSec / 1_000_000; // microdollars to dollars
    const secondsRemaining = balanceDollars / costDollarsPerSec;
    if (secondsRemaining > 7 * 24 * 3600) return '>7d';
    if (secondsRemaining > 24 * 3600) return `~${Math.round(secondsRemaining / 3600)}h`;
    if (secondsRemaining > 3600) return `~${(secondsRemaining / 3600).toFixed(1)}h`;
    if (secondsRemaining > 60) return `~${Math.round(secondsRemaining / 60)}m`;
    return '<1m';
  }, [costPerSec, balanceDollars]);

  return (
    <div className="flex flex-col items-center gap-1 px-4 py-3">
      <div className={`flex items-center gap-1 ${gaugeColor}`}>
        <Fuel className="size-3.5" />
        <span className="text-[10px] font-medium tracking-wide uppercase opacity-70">Gas Tank</span>
      </div>
      {/* Vertical fuel gauge */}
      <div className={`h-8 w-14 overflow-hidden rounded-md ${bgColor}`}>
        <div
          className={`${fillColor} w-full transition-all duration-700 ease-out`}
          style={{ height: `${ratio * 100}%`, marginTop: `${(1 - ratio) * 100}%` }}
        />
      </div>
      <div className="text-center">
        <motion.span
          key={fill.toFixed(2)}
          initial={{ opacity: 0.4 }}
          animate={{ opacity: 1 }}
          className="font-mono text-sm font-semibold text-white/85"
        >
          {balanceDollars !== null ? `$${balanceDollars.toFixed(2)}` : '---'}
        </motion.span>
        {timeRemaining && <div className="text-[9px] text-white/30">{timeRemaining} at pace</div>}
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────

export function ThroughputGauges({ throughput, gasTank }: ThroughputGaugesProps) {
  const t = throughput ?? {
    tokensPerSec: 0,
    costPerSec: 0,
    activeAgents: 0,
    totalAgents: 0,
    locAdditions: 0,
    locDeletions: 0,
  };
  const totalLoc = t.locAdditions + t.locDeletions;

  return (
    <div className="flex items-stretch justify-around border-b border-white/[0.06]">
      <RadialGauge
        value={t.tokensPerSec}
        max={200}
        label="Tokens/sec"
        unit="tok/s (5m avg)"
        icon={<Zap className="size-3.5" />}
        color="text-sky-400"
      />
      <div className="w-px bg-white/[0.06]" />
      <RadialGauge
        value={t.costPerSec / 1_000_000}
        max={0.01}
        label="Cost/sec"
        unit="$/s (5m avg)"
        icon={<DollarSign className="size-3.5" />}
        color="text-amber-400"
        formatValue={v => (v < 0.001 ? v.toFixed(4) : v.toFixed(3))}
      />
      <div className="w-px bg-white/[0.06]" />
      <RadialGauge
        value={totalLoc}
        max={Math.max(totalLoc, 500)}
        label="Lines Changed"
        unit={`+${t.locAdditions} / -${t.locDeletions}`}
        icon={<FileCode className="size-3.5" />}
        color="text-violet-400"
        formatValue={v => `${v}`}
      />
      <div className="w-px bg-white/[0.06]" />
      <RadialGauge
        value={t.activeAgents}
        max={Math.max(t.totalAgents, 1)}
        label="Active Agents"
        unit={`${t.activeAgents} / ${t.totalAgents}`}
        icon={<Bot className="size-3.5" />}
        color="text-emerald-400"
        formatValue={v => `${v}`}
      />
      {gasTank && (
        <>
          <div className="w-px bg-white/[0.06]" />
          <GasTankGauge balanceDollars={gasTank.balanceDollars} costPerSec={gasTank.costPerSec} />
        </>
      )}
    </div>
  );
}

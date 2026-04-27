'use client';

import { useEffect, useState } from 'react';

export type BotPresence = {
  online: boolean;
  lastAt: number;
};

export type BotDisplayState = 'online' | 'idle' | 'offline' | 'unknown';

type BotDisplay = {
  state: BotDisplayState;
  label: 'Online' | 'Idle' | 'Offline' | 'Unknown';
};

export function computeBotDisplay(params: {
  instanceStatus: string | null;
  presence: BotPresence | undefined;
  now: number;
}): BotDisplay {
  if (params.instanceStatus !== 'running') return { state: 'offline', label: 'Offline' };
  if (!params.presence) return { state: 'unknown', label: 'Unknown' };
  if (!params.presence.online) return { state: 'offline', label: 'Offline' };
  const elapsed = params.now - params.presence.lastAt;
  if (elapsed > 90_000) return { state: 'offline', label: 'Offline' };
  if (elapsed > 30_000) return { state: 'idle', label: 'Idle' };
  return { state: 'online', label: 'Online' };
}

const DOT_CLASS: Record<BotDisplayState, string> = {
  online: 'bg-green-500',
  idle: 'bg-amber-500',
  offline: 'bg-muted-foreground/50',
  unknown: 'bg-muted-foreground/30',
};

type BotStatusProps = {
  instanceStatus: string | null;
  presence?: BotPresence;
  model?: string | null;
};

export function BotStatus({ instanceStatus, presence, model }: BotStatusProps) {
  const now = useNowTicker(10_000);
  const display = computeBotDisplay({ instanceStatus, presence, now });
  const tooltip = buildTooltip(display.state, presence, now, model ?? null);
  return (
    <div className="flex items-center gap-1.5" title={tooltip}>
      <div className={`h-2 w-2 rounded-full ${DOT_CLASS[display.state]}`} />
      <span className="text-muted-foreground text-xs">{display.label}</span>
    </div>
  );
}

// Staleness ticker: keeps re-renders scoped to the subtree that uses it so
// sibling components (memoized message bubbles, etc.) are not invalidated
// every tick. Exported so MessageArea can reuse it for the send-gate that
// reacts to presence going stale without any user interaction.
export function useNowTicker(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function buildTooltip(
  state: BotDisplayState,
  presence: BotPresence | undefined,
  now: number,
  model: string | null
): string {
  if (state === 'unknown' || !presence) return 'Bot status unknown';
  if (state === 'offline') return 'Bot is offline';
  const seconds = Math.max(0, Math.round((now - presence.lastAt) / 1000));
  const bits = [`Last heartbeat ${seconds}s ago`];
  if (model) bits.push(`model: ${model}`);
  return bits.join(' · ');
}

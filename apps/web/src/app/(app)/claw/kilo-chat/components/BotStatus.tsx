'use client';

export type BotPresence = {
  online: boolean;
  lastAt: number;
  model?: string | null;
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
};

export function BotStatus({ instanceStatus, presence }: BotStatusProps) {
  const display = computeBotDisplay({ instanceStatus, presence, now: Date.now() });
  const tooltip = buildTooltip(display.state, presence);
  return (
    <div className="flex items-center gap-1.5" title={tooltip}>
      <div className={`h-2 w-2 rounded-full ${DOT_CLASS[display.state]}`} />
      <span className="text-muted-foreground text-xs">{display.label}</span>
    </div>
  );
}

function buildTooltip(state: BotDisplayState, presence: BotPresence | undefined): string {
  if (state === 'unknown' || !presence) return 'Bot status unknown';
  if (state === 'offline') return 'Bot is offline';
  const seconds = Math.max(0, Math.round((Date.now() - presence.lastAt) / 1000));
  const bits = [`Last heartbeat ${seconds}s ago`];
  if (presence.model) bits.push(`model: ${presence.model}`);
  return bits.join(' · ');
}

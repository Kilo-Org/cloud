'use client';

type BotStatusProps = {
  instanceStatus: string | null;
};

export function BotStatus({ instanceStatus }: BotStatusProps) {
  if (instanceStatus === 'running') {
    return (
      <div className="flex items-center gap-1.5">
        <div className="h-2 w-2 rounded-full bg-green-500" />
        <span className="text-muted-foreground text-xs">Online</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="bg-muted-foreground/50 h-2 w-2 rounded-full" />
      <span className="text-muted-foreground text-xs">Offline</span>
    </div>
  );
}

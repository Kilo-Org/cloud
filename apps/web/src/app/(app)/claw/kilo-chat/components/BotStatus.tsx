'use client';

type BotStatusProps = {
  isTyping: boolean;
  instanceStatus: string | null;
};

export function BotStatus({ isTyping, instanceStatus }: BotStatusProps) {
  if (isTyping) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="h-2 w-2 rounded-full bg-green-500" />
        <span className="text-muted-foreground text-xs">
          typing
          <span className="inline-flex gap-0.5">
            <span className="animate-bounce" style={{ animationDelay: '0ms' }}>
              .
            </span>
            <span className="animate-bounce" style={{ animationDelay: '150ms' }}>
              .
            </span>
            <span className="animate-bounce" style={{ animationDelay: '300ms' }}>
              .
            </span>
          </span>
        </span>
      </div>
    );
  }

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

'use client';

type BotStatusProps = {
  isTyping: boolean;
};

export function BotStatus({ isTyping }: BotStatusProps) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`h-2 w-2 rounded-full ${isTyping ? 'bg-green-500' : 'bg-muted-foreground/50'}`}
      />
      <span className="text-muted-foreground text-xs">
        {isTyping ? 'Active' : 'Offline'}
      </span>
    </div>
  );
}

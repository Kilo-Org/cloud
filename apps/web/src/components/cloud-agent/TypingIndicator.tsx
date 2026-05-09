'use client';

import { Bot } from 'lucide-react';

export function TypingIndicator() {
  return (
    <div className="flex items-start gap-3 py-4">
      <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full">
        <Bot className="size-4" />
      </div>
      <div className="mt-2 flex gap-1">
        <div className="bg-muted-foreground size-2 animate-typing-dot rounded-full [animation-delay:-0.3s]" />
        <div className="bg-muted-foreground size-2 animate-typing-dot rounded-full [animation-delay:-0.15s]" />
        <div className="bg-muted-foreground size-2 animate-typing-dot rounded-full" />
      </div>
    </div>
  );
}

'use client';

import { Bot } from 'lucide-react';

export function TypingIndicator() {
  return (
    <div className="flex items-start gap-3 py-4">
      <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        <Bot className="h-4 w-4" />
      </div>
      <div className="mt-2 flex gap-1">
        <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
        <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
        <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" />
      </div>
    </div>
  );
}

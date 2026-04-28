'use client';

import { MessageSquare } from 'lucide-react';

type ChatTabProps = {
  enabled: boolean;
};

export function ChatTab({ enabled }: ChatTabProps) {
  if (!enabled) {
    return <ChatPlaceholder message="Chat is available when the machine is running." />;
  }

  return <ChatPlaceholder message="Chat is loading…" />;
}

function ChatPlaceholder({ message, isError = false }: { message: string; isError?: boolean }) {
  return (
    <div
      className={`flex h-96 flex-col items-center justify-center gap-4 px-6 text-center ${isError ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/5">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm">{message}</p>
    </div>
  );
}

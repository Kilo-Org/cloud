'use client';

import { Sparkles } from 'lucide-react';

type WelcomeBubbleProps = {
  assistantName: string | null;
  assistantEmoji: string | null;
};

export function WelcomeBubble({ assistantName, assistantEmoji }: WelcomeBubbleProps) {
  const name = assistantName ?? 'KiloClaw';

  return (
    <div className="flex flex-1 items-start gap-3 px-4 py-6">
      <div className="bg-muted text-foreground flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-lg leading-none">
        {assistantEmoji ? <span>{assistantEmoji}</span> : <Sparkles className="h-4 w-4" />}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs font-medium">{name}</span>
        <div className="bg-muted/50 border-border max-w-prose rounded-2xl rounded-tl-sm border px-4 py-3">
          <p className="text-foreground text-sm leading-relaxed">
            Hi! I&apos;m {name}. Ask me to draft a message, make a checklist, or help you think
            through a decision.
          </p>
        </div>
      </div>
    </div>
  );
}

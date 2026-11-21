'use client';

import { RotateCw } from 'lucide-react';
import type { RuntimeContinuation, RuntimeContinuationReason } from './runtime-continuation';

const REASON_DESCRIPTIONS = {
  interrupted: 'The previous response was interrupted.',
  restarted: 'The server restarted while the agent was working.',
  'output-limit': 'The response reached the output token limit.',
} satisfies Record<RuntimeContinuationReason, string>;

export function RuntimeContinuationCard({ continuation }: { continuation: RuntimeContinuation }) {
  return (
    <div className="border-border bg-card flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-left text-sm">
      <RotateCw className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      <span className="font-medium">Continued automatically</span>
      <span className="text-muted-foreground min-w-0">
        {REASON_DESCRIPTIONS[continuation.reason]}
      </span>
    </div>
  );
}

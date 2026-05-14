'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';

type KiloChatStatusErrorProps = {
  message: string | null;
  onRetry: () => void;
};

export function KiloChatStatusError({ message, onRetry }: KiloChatStatusErrorProps) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="border-border bg-background flex max-w-md flex-col items-center gap-3 rounded-lg border p-6 text-center">
        <AlertCircle className="text-destructive h-8 w-8" />
        <div className="space-y-1">
          <p className="text-sm font-medium">Failed to load status</p>
          <p className="text-muted-foreground text-sm">{message ?? 'Please try again.'}</p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="border-input hover:bg-accent hover:text-accent-foreground inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    </div>
  );
}

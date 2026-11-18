'use client';

import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LocalSession } from './local-session';

/** A chat created here that the server did not create: its reason, with Retry and Discard. */
export function LocalChatFailure({
  session,
  onRetry,
  onDiscard,
}: {
  session: LocalSession;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  if (session.sync.state !== 'failed') return null;

  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 my-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-sm"
    >
      <CircleAlert className="text-destructive h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">
          {session.firstMessage ? 'This session was not created.' : 'This chat was not created.'}
        </span>{' '}
        <span className="text-muted-foreground">{session.sync.message}</span>
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </div>
  );
}

'use client';

import { format } from 'date-fns';
import { ChevronDown, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SessionStatusIndicator } from '@/components/shared/SessionStatusIndicator';
import { TimeAgo } from '@/components/shared/TimeAgo';
import {
  getMaintenanceChatSessions,
  isMaintenanceChatPinned,
} from './maintenance-chat-presentation';
import type { StoredSession } from './types';

export function AutoFixHistory({
  sessions,
  currentSessionId,
  deletingSessionIds,
  onSelectSession,
}: {
  sessions: readonly StoredSession[];
  currentSessionId: string | null;
  deletingSessionIds: readonly string[];
  onSelectSession: (sessionId: string) => void;
}) {
  const runs = getMaintenanceChatSessions(sessions);
  const current = runs.find(session => session.sessionId === currentSessionId);
  const latest = runs[0];
  if (!current || !latest) return null;

  const viewingHistory = current.sessionId !== latest.sessionId;
  const latestLabel = isMaintenanceChatPinned(latest) ? 'Current run' : 'Latest run';

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 border-b px-4 py-1 text-xs">
      <span className="text-muted-foreground flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
        <span>{viewingHistory ? 'Earlier run' : latestLabel}</span>
        <TimeAgo timestamp={current.createdAt} compact />
      </span>
      {viewingHistory && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs [@media(any-pointer:coarse)]:h-11"
          disabled={deletingSessionIds.includes(latest.sessionId)}
          onClick={() => onSelectSession(latest.sessionId)}
        >
          {isMaintenanceChatPinned(latest) ? 'Back to current run' : 'Back to latest run'}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Auto-fix history"
            className="h-8 gap-1.5 px-2 text-xs [@media(any-pointer:coarse)]:h-11"
          >
            <History className="h-3.5 w-3.5" aria-hidden="true" />
            History
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          aria-label="Auto-fix history"
          className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-2rem)]"
        >
          <DropdownMenuLabel>Auto-fix history</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={currentSessionId ?? undefined}
            onValueChange={onSelectSession}
          >
            {runs.map(session => (
              <DropdownMenuRadioItem
                key={session.sessionId}
                value={session.sessionId}
                disabled={deletingSessionIds.includes(session.sessionId)}
                textValue={session.prompt}
                className="py-2 [@media(any-pointer:coarse)]:min-h-11"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-2 text-xs">
                    {session.sessionId === latest.sessionId ? latestLabel : 'Earlier run'}
                    <SessionStatusIndicator
                      status={session.sessionStatus ?? null}
                      statusUpdatedAt={session.sessionStatusUpdatedAt ?? null}
                    />
                  </span>
                  <time
                    dateTime={new Date(session.createdAt).toISOString()}
                    className="text-muted-foreground text-xs"
                  >
                    {format(new Date(session.createdAt), 'MMM d, yyyy HH:mm:ss')}
                  </time>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

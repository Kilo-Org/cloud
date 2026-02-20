'use client';

import { Button } from '@/components/Button';
import { Card } from '@/components/ui/card';
import { Plus, GitBranch, Clock } from 'lucide-react';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { formatDistanceToNow } from 'date-fns';
import { useRouter } from 'next/navigation';
import type { StoredSession } from './types';
import { cn } from '@/lib/utils';

type ChatSidebarProps = {
  sessions: StoredSession[];
  currentSessionId?: string;
  organizationId?: string;
  onNewSession: () => void;
  onSelectSession?: (sessionId: string) => void;
  /** Delete handler - receives sessionId (UUID) */
  onDeleteSession?: (sessionId: string) => void;
  isInSheet?: boolean;
};

function truncateText(text: string, maxLength: number = 50): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

export function ChatSidebar({
  sessions,
  currentSessionId,
  organizationId,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  isInSheet = false,
}: ChatSidebarProps) {
  const router = useRouter();

  const handleSessionClick = (sessionId: string) => {
    if (onSelectSession) {
      onSelectSession(sessionId);
    } else {
      // Navigate to the session
      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      router.push(`${basePath}/chat?sessionId=${sessionId}`);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {isInSheet ? (
        // Mobile Sheet layout - extra top padding to avoid overlapping with close button
        <div className="border-b px-4 pt-14 pb-4">
          <Button onClick={onNewSession} className="w-full" variant="primary" size="sm">
            <Plus className="mr-2 h-4 w-4" />
            New Session
          </Button>
        </div>
      ) : (
        // Desktop layout
        <div className="border-b p-4">
          <Button onClick={onNewSession} className="w-full" variant="primary" size="sm">
            <Plus className="mr-2 h-4 w-4" />
            New Session
          </Button>
        </div>
      )}

      {/* Sessions List - same for both */}
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {sessions.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500">No sessions yet</div>
        ) : (
          sessions.map(session => {
            const isActive = session.sessionId === currentSessionId;
            const timeAgo = formatDistanceToNow(new Date(session.updatedAt), {
              addSuffix: true,
            });

            return (
              <Card
                key={session.sessionId}
                onClick={() => handleSessionClick(session.sessionId)}
                className={cn(
                  'hover:bg-accent group relative cursor-pointer p-3 transition-colors',
                  isActive && 'border-primary bg-accent'
                )}
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 flex-1 text-sm font-medium">
                      {truncateText(session.prompt, 60)}
                    </p>
                    {/* Delete button - works for all sessions */}
                    {onDeleteSession && (
                      <div
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={event => event.stopPropagation()}
                      >
                        <InlineDeleteConfirmation
                          onDelete={() => onDeleteSession(session.sessionId)}
                          showAsButton={false}
                        />
                      </div>
                    )}
                  </div>
                  <div className="text-muted-foreground flex items-center gap-1 text-xs">
                    <GitBranch className="h-3 w-3" />
                    <span className="truncate">{session.repository}</span>
                  </div>
                  <div className="text-muted-foreground flex items-center gap-1 text-xs">
                    <Clock className="h-3 w-3" />
                    <span>{timeAgo}</span>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

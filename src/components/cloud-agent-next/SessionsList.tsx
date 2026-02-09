'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Bot, Clock, Cloud, GitBranch, Puzzle, Terminal } from 'lucide-react';
import type { StoredSession } from './types';
import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';

export type SessionsListItem = Pick<
  StoredSession,
  'sessionId' | 'createdAt' | 'createdOnPlatform' | 'prompt' | 'repository' | 'mode'
>;

export type SessionsListProps = {
  sessions: SessionsListItem[];
  organizationId?: string;
  onSessionClick?: (session: SessionsListItem) => void;
};

function truncateId(id: string, length: number = 8): string {
  return id.length > length ? `${id.slice(0, length)}...` : id;
}

export function SessionsList({ sessions, organizationId, onSessionClick }: SessionsListProps) {
  if (sessions.length === 0) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center">
            <p className="text-lg text-gray-300">No sessions yet</p>
            <p className="mt-2 text-sm text-gray-500">
              Create your first cloud agent session above
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const basePath = organizationId ? `/organizations/${organizationId}/cloud-next` : '/cloud-next';

  return (
    <div className="space-y-3">
      {sessions.map(session => {
        const chatUrl = `${basePath}/chat?sessionId=${session.sessionId}`;
        const timeAgo = formatDistanceToNow(new Date(session.createdAt), { addSuffix: true });

        // Determine badge based on created_on_platform field
        const platform = session.createdOnPlatform;
        let badge: React.ReactNode;

        if (platform === 'cloud-agent') {
          badge = (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-400">
              <Cloud className="h-3 w-3" />
              Cloud
            </span>
          );
        } else if (platform === 'cli') {
          badge = (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-zinc-500/20 px-2 py-0.5 text-xs font-medium text-zinc-400">
              <Terminal className="h-3 w-3" />
              CLI
            </span>
          );
        } else if (platform === 'agent-manager') {
          badge = (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-orange-500/20 px-2 py-0.5 text-xs font-medium text-orange-400">
              <Bot className="h-3 w-3" />
              Agent Manager
            </span>
          );
        } else if (platform === 'slack') {
          badge = (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400">
              <Bot className="h-3 w-3" />
              Slack
            </span>
          );
        } else {
          // Default to Extension badge for unknown, vscode, etc.
          badge = (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-purple-500/20 px-2 py-0.5 text-xs font-medium text-purple-400">
              <Puzzle className="h-3 w-3" />
              Extension
            </span>
          );
        }

        const cardContent = (
          <Card className="hover:bg-accent cursor-pointer transition-colors">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  {/* Stack vertically on mobile, horizontal on sm+ */}
                  <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
                    <CardTitle className="text-base font-medium sm:truncate">
                      {session.prompt}
                    </CardTitle>
                    {badge}
                  </div>
                  <CardDescription className="mt-1 flex items-center gap-2">
                    <GitBranch className="h-3 w-3" />
                    <span className="truncate">{session.repository}</span>
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  <span>{timeAgo}</span>
                </div>
                <div className="font-mono">ID: {truncateId(session.sessionId)}</div>
                {session.mode && (
                  <div>
                    Mode: <span className="font-medium">{session.mode}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );

        return onSessionClick ? (
          <div key={session.sessionId} onClick={() => onSessionClick(session)} className="block">
            {cardContent}
          </div>
        ) : (
          <Link key={session.sessionId} href={chatUrl} className="block">
            {cardContent}
          </Link>
        );
      })}
    </div>
  );
}

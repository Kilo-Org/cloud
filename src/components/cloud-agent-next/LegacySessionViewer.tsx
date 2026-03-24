'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Loader2, GitBranch } from 'lucide-react';
import { OldSessionBanner } from './OldSessionBanner';
import { LegacyMessageBubble } from './LegacyMessageBubble';
import { MessageErrorBoundary } from './MessageErrorBoundary';
import { convertToCloudMessages } from './legacy-session-types';
import type { CloudMessage } from './legacy-session-types';

type LegacySessionViewerProps = {
  sessionId: string;
  organizationId?: string;
};

export function LegacySessionViewer({ sessionId, organizationId }: LegacySessionViewerProps) {
  const router = useRouter();
  const trpc = useTRPC();

  const {
    data: session,
    isLoading: isSessionLoading,
    error: sessionError,
  } = useQuery(trpc.cliSessions.get.queryOptions({ session_id: sessionId }));

  const { data: messagesData, isLoading: isMessagesLoading } = useQuery(
    trpc.cliSessions.getSessionMessages.queryOptions({ session_id: sessionId })
  );

  const messages: CloudMessage[] = useMemo(() => {
    if (!messagesData?.messages) return [];
    return convertToCloudMessages(messagesData.messages as Array<Record<string, unknown>>);
  }, [messagesData]);

  const isLoading = isSessionLoading || isMessagesLoading;

  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
        <p className="text-muted-foreground text-sm">Loading session...</p>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-destructive text-sm font-medium">Failed to load session</p>
        <p className="text-muted-foreground text-xs">{sessionError.message}</p>
      </div>
    );
  }

  const newSessionUrl = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';

  const title = session?.title || 'Untitled Session';
  const gitUrl = session?.git_url;
  const model = session?.last_model;
  const createdAt = session?.created_at
    ? new Date(session.created_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 md:px-6">
        <OldSessionBanner onStartNewSession={() => router.push(newSessionUrl)} />
      </div>

      <div className="px-4 pb-3 md:px-6">
        <h1 className="text-base font-medium">{title}</h1>
        <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-sm">
          {gitUrl && (
            <span className="flex items-center gap-1">
              <GitBranch className="h-3.5 w-3.5" />
              {gitUrl}
            </span>
          )}
          {gitUrl && model && <span>·</span>}
          {model && <span>{model}</span>}
          {(gitUrl || model) && createdAt && <span>·</span>}
          {createdAt && <span>{createdAt}</span>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6">
        <div className="mx-auto max-w-3xl">
          {messages.length === 0 ? (
            <p className="text-muted-foreground py-12 text-center text-sm">
              No messages found in this session.
            </p>
          ) : (
            messages.map((msg, index) => (
              <MessageErrorBoundary key={`${msg.ts}-${index}`}>
                <LegacyMessageBubble message={msg} />
              </MessageErrorBoundary>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

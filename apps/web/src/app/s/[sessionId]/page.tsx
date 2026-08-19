import React from 'react';
import { notFound } from 'next/navigation';
import { CalendarDays, GitBranch } from 'lucide-react';
import { AnimatedLogo } from '@/components/AnimatedLogo';
import { APP_URL } from '@/lib/constants';
import {
  fetchSharedSessionMetadata,
  fetchSharedSessionSnapshot,
} from '@/lib/session-ingest-client';
import { OpenInCliButton } from '@/app/share/[shareId]/open-in-cli-button';
import { OpenInEditorButton } from '@/app/share/[shareId]/open-in-editor-button';
import { Button } from '@/components/ui/button';
import { SharedSessionTranscript } from './shared-session-transcript';
import { formatRepoFromGitUrl, formatSessionDate } from './shared-session-meta';
import { toSharedTranscriptMessages } from './shared-transcript';

export const dynamic = 'force-dynamic';

export default async function SharedSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId: shareToken } = await params;
  const [session, snapshot] = await Promise.all([
    fetchSharedSessionMetadata(shareToken),
    fetchSharedSessionSnapshot(shareToken),
  ]);

  if (!session) {
    return notFound();
  }

  const shareUrl = `${APP_URL}/s/${shareToken}`;
  const importCommand = `kilo import ${shareUrl}`;
  const messages = snapshot ? toSharedTranscriptMessages(snapshot.messages) : [];
  const ownerName = session.ownerName ?? 'Someone';
  const repo = formatRepoFromGitUrl(session.gitUrl);
  const sessionDate = formatSessionDate(session.createdAt);

  return (
    <div className="bg-background min-h-screen">
      <header className="border-border bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-2">
          <AnimatedLogo />
          <Button asChild variant="ghost" size="sm">
            <a href="https://kilo.ai/install" target="_blank" rel="noopener noreferrer">
              Install Kilo
            </a>
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">
        <section className="border-border flex flex-col gap-4 border-b pb-8">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-xl font-semibold tracking-tight">
              {session.title ?? `${ownerName} shared a session`}
            </h2>
            {session.title && (
              <p className="text-muted-foreground text-sm">Shared by {ownerName}</p>
            )}
            {(repo || session.gitBranch || sessionDate) && (
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {repo && <span>{repo}</span>}
                {session.gitBranch && (
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="size-3.5" aria-hidden />
                    {session.gitBranch}
                  </span>
                )}
                {sessionDate && (
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="size-3.5" aria-hidden />
                    {sessionDate}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <OpenInCliButton command={importCommand} variant="default" />
            <OpenInEditorButton sessionId={shareToken} pathOverride={`/s/${shareToken}`} />
          </div>
        </section>

        <SharedSessionTranscript messages={messages} />
      </main>
    </div>
  );
}

import { notFound } from 'next/navigation';
import { AnimatedLogo } from '@/components/AnimatedLogo';
import { CopyableCommand } from '@/components/CopyableCommand';
import { APP_URL } from '@/lib/constants';
import {
  fetchSharedSessionMetadata,
  fetchSharedSessionSnapshot,
} from '@/lib/session-ingest-client';
import { OpenInCliButton } from '@/app/share/[shareId]/open-in-cli-button';
import { OpenInEditorButton } from '@/app/share/[shareId]/open-in-editor-button';
import { SharedSessionTranscript } from './shared-session-transcript';
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

  return (
    <div className="bg-background min-h-screen">
      <header className="border-border bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <AnimatedLogo />
          <div className="flex flex-wrap items-center gap-2">
            <OpenInEditorButton sessionId={shareToken} pathOverride={`/s/${shareToken}`} />
            <OpenInCliButton command={importCommand} />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {session.ownerName ?? 'Someone'} shared a session
          </h1>
          {session.title && <p className="text-muted-foreground text-sm">{session.title}</p>}
        </div>

        <SharedSessionTranscript messages={messages} />

        <section className="border-border flex flex-col gap-3 border-t pt-6">
          <div>
            <div className="text-sm font-medium">Import in CLI</div>
            <p className="text-muted-foreground mt-1 text-xs">
              Copy the command, then paste it in your terminal.
            </p>
          </div>
          <CopyableCommand
            command={importCommand}
            className="bg-muted/40 rounded-lg border px-3 py-2 text-sm"
          />
          <p className="text-muted-foreground text-xs">
            Need the CLI?{' '}
            <a
              href="https://kilo.ai/install"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground decoration-border hover:decoration-foreground underline underline-offset-4"
            >
              Install Kilo
            </a>
          </p>
        </section>
      </main>
    </div>
  );
}

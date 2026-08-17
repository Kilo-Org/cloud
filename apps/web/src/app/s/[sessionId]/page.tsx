import { notFound } from 'next/navigation';
import { AnimatedLogo } from '@/components/AnimatedLogo';
import { CopyableCommand } from '@/components/CopyableCommand';
import { APP_URL } from '@/lib/constants';
import { fetchSharedSessionMetadata } from '@/lib/session-ingest-client';
import { OpenInCliButton } from '@/app/share/[shareId]/open-in-cli-button';
import { OpenInEditorButton } from '@/app/share/[shareId]/open-in-editor-button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function SharedSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId: shareToken } = await params;
  const session = await fetchSharedSessionMetadata(shareToken);

  if (!session) {
    return notFound();
  }

  const shareUrl = `${APP_URL}/s/${shareToken}`;
  const importCommand = `kilo import ${shareUrl}`;

  return (
    <div className="bg-background relative min-h-screen overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_50%_0%,hsl(var(--primary)/0.16),transparent_60%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--foreground))_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--foreground))_1px,transparent_1px)] bg-size-[72px_72px] opacity-[0.07]" />
        <div className="via-border absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent to-transparent" />
      </div>

      <main className="mx-auto flex min-h-svh w-full max-w-3xl flex-col items-center justify-center px-4 py-12 sm:py-16">
        <div className="flex w-full flex-col items-center gap-6 sm:gap-8">
          <div className="animate-in fade-in slide-in-from-top-4 duration-500">
            <AnimatedLogo />
          </div>

          <Card className="animate-in fade-in slide-in-from-bottom-4 w-full max-w-2xl duration-700">
            <CardHeader className="items-center pb-4 text-center">
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                {session.ownerName ?? 'Someone'} shared a session
              </h1>
              {session.title && (
                <div className="text-muted-foreground mt-2 text-sm sm:text-base">
                  {session.title}
                </div>
              )}
            </CardHeader>

            <CardContent className="flex flex-col gap-4">
              <div className="bg-muted/40 rounded-xl border p-5 shadow-sm">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-left">
                    <div className="text-sm font-medium">Open in Extension</div>
                    <div className="text-muted-foreground mt-1 text-xs">
                      Open this session directly in your editor.
                    </div>
                  </div>
                  <div className="flex justify-start sm:justify-end">
                    <OpenInEditorButton sessionId={shareToken} pathOverride={`/s/${shareToken}`} />
                  </div>
                </div>
              </div>

              <div className="bg-muted/40 rounded-xl border p-5 shadow-sm">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-left">
                    <div className="text-sm font-medium">Import in CLI</div>
                    <div className="text-muted-foreground mt-1 text-xs">
                      Copy the command, then paste it in your terminal.
                    </div>
                  </div>
                  <div className="flex justify-start sm:justify-end">
                    <OpenInCliButton command={importCommand} />
                  </div>
                </div>

                <div className="mt-3">
                  <CopyableCommand
                    command={importCommand}
                    className="bg-background/70 rounded-lg border px-3 py-2 text-sm shadow-sm"
                  />
                </div>
              </div>

              <div className="text-muted-foreground pt-2 text-center text-xs">
                Need the CLI?{' '}
                <a
                  href="https://kilo.ai/install"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground decoration-border hover:decoration-foreground underline underline-offset-4"
                >
                  Install Kilo
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}

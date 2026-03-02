import { db } from '@/lib/drizzle';
import { and, eq } from 'drizzle-orm';
import { cliSessions, sharedCliSessions, kilocode_users } from '@kilocode/db/schema';
import { CliSessionSharedState } from '@/types/cli-session-shared-state';
import { notFound } from 'next/navigation';
import { AnimatedLogo } from '@/components/AnimatedLogo';
import { CopyableCommand } from '@/components/CopyableCommand';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { GitBranch, ChevronRight, ChevronDown } from 'lucide-react';
import { getBlobContent } from '@/lib/r2/cli-sessions';
import type { Message } from '@/components/cloud-agent/types';
import { SessionPreviewDialog } from '@/app/share/[shareId]/session-preview-dialog';
import { captureException } from '@sentry/nextjs';
import {
  AnyBlobMessageSchema,
  type AnyBlobMessage,
  parseFollowupTextContent,
} from './blob-message-types';
import { OpenInCliButton } from '@/app/share/[shareId]/open-in-cli-button';
import { OpenInEditorButton } from '@/app/share/[shareId]/open-in-editor-button';
import { cookies } from 'next/headers';
import { getExtensionUrl } from '@/components/auth/getExtensionUrl';
import { validate as isValidUUID } from 'uuid';

export const revalidate = 86400;

/**
 * Extracts text content from a blob message based on its type.
 */
function extractTextContent(msg: AnyBlobMessage): string | null {
  if (msg.partial) return null;

  if (msg.type === 'ask' && msg.ask === 'followup') {
    try {
      const content = parseFollowupTextContent(msg.text);
      return content.question;
    } catch {
      return null;
    }
  }

  return msg.text || null;
}

/**
 * Converts CLI blob messages to the Message format expected by the chat UI.
 */
function convertToMessages(cliMessages: AnyBlobMessage[]): Message[] {
  const results: Message[] = [];

  for (let i = 0; i < cliMessages.length; i++) {
    const msg = cliMessages[i];

    const content = extractTextContent(msg);
    if (!content) continue;

    // Assume the first message is from the user
    if (i === 0 || (msg.type === 'say' && msg.say === 'user_feedback')) {
      results.push({
        role: 'user',
        content,
        timestamp: new Date(msg.ts).toISOString(),
      });
    } else {
      results.push({
        role: 'assistant',
        content,
        timestamp: new Date(msg.ts).toISOString(),
      });
    }
  }

  return results;
}

export default async function SharePage({
  params,
  searchParams,
}: {
  params: Promise<{ shareId: string }>;
  searchParams: Promise<NextAppSearchParams>;
}) {
  const { shareId } = await params;
  const resolvedSearchParams = await searchParams;
  const cookieStore = await cookies();
  const { editor: defaultEditor } = getExtensionUrl(resolvedSearchParams, cookieStore);

  // Validate shareId is a valid UUID before querying the database
  if (!isValidUUID(shareId)) {
    return notFound();
  }

  const sessionResult = await db
    .select({
      sessionId: sharedCliSessions.session_id,
      sharedState: sharedCliSessions.shared_state,
      ownerName: kilocode_users.google_user_name,
      ownerAvatarUrl: kilocode_users.google_user_image_url,
      gitUrl: cliSessions.git_url,
      uiMessagesBlobUrl: sharedCliSessions.ui_messages_blob_url,
      title: cliSessions.title,
    })
    .from(sharedCliSessions)
    .leftJoin(cliSessions, eq(sharedCliSessions.session_id, cliSessions.session_id))
    .leftJoin(kilocode_users, eq(cliSessions.kilo_user_id, kilocode_users.id))
    .where(
      and(
        eq(sharedCliSessions.share_id, shareId),
        eq(sharedCliSessions.shared_state, CliSessionSharedState.Public)
      )
    )
    .limit(1);

  if (sessionResult.length === 0) {
    return notFound();
  }

  const session = sessionResult[0];
  let messages: Message[] = [];

  try {
    if (session.uiMessagesBlobUrl) {
      const blob = (await getBlobContent(session.uiMessagesBlobUrl || '')) as unknown[];
      const cliMessages = blob.filter(
        (msg): msg is AnyBlobMessage => AnyBlobMessageSchema.safeParse(msg).success
      );
      messages = convertToMessages(cliMessages);
    }
  } catch (e) {
    captureException(e, {
      level: 'warning',
      tags: { source: 'share_page' },
      extra: { shareId, sessionId: session.sessionId },
    });
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mx-auto flex flex-col items-center gap-12">
        <AnimatedLogo />

        <div className="flex w-full flex-col items-center gap-8 text-center">
          <div className="flex flex-col gap-6">
            <h1 className="text-4xl font-bold tracking-tight">
              {session.ownerName ?? 'Someone'} shared a session
            </h1>

            {/* Session Preview Dialog */}
            {messages.length > 0 && (
              <SessionPreviewDialog
                messages={messages.slice(0, 10)}
                totalCount={messages.length}
                userName={session.ownerName ?? undefined}
                userAvatarUrl={session.ownerAvatarUrl ?? undefined}
                sessionTitle={session.title ?? undefined}
              />
            )}

            {/* Git Clone Instructions Accordion */}
            {session.gitUrl && (
              <Accordion type="single" collapsible className="mx-auto w-full">
                <AccordionItem value="git-clone" className="border-none">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground rounded-lg px-4 py-3 text-sm transition-colors hover:no-underline [&>svg]:hidden [&[data-state=closed]>div>.chevron-down]:hidden [&[data-state=open]>div>.chevron-right]:hidden">
                    <div className="flex items-center gap-2">
                      <GitBranch className="h-4 w-4" />
                      <span>Clone the repository to work locally</span>
                      <ChevronRight className="chevron-right ml-auto h-4 w-4 shrink-0 transition-transform duration-200" />
                      <ChevronDown className="chevron-down ml-auto h-4 w-4 shrink-0 transition-transform duration-200" />
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-4 pt-2 pb-4">
                    <div className="flex flex-col gap-3">
                      <p className="text-muted-foreground text-sm">
                        Clone the git repository to your local machine:
                      </p>
                      <CopyableCommand
                        command={`git clone ${session.gitUrl}`}
                        className="bg-muted rounded-md px-3 py-2 text-sm"
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}

            {/* Action Buttons */}
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
              <OpenInEditorButton sessionId={shareId} defaultEditor={defaultEditor} />
              <OpenInCliButton command={`kilocode --fork ${shareId}`} />
            </div>

            {/* Manual fork instructions */}
            <div className="text-muted-foreground flex flex-col gap-2 text-center text-sm">
              <CopyableCommand
                command={`/session fork ${shareId}`}
                className="bg-muted rounded-md px-3 py-2 text-sm"
              />
            </div>

            {/* Installation instructions */}
            <div className="text-muted-foreground text-center text-sm">
              Don't have Kilo Code installed?{' '}
              <a
                href="https://kilo.ai/install"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 underline hover:text-blue-300"
              >
                Get started here
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

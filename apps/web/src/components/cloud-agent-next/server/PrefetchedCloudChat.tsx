import 'server-only';
import type { ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { TRPCError } from '@trpc/server';
import {
  sessionConfigFromFetchedSession,
  type CachedSessionSnapshotPage,
  type CloudAgentSessionId,
  type KiloSessionId,
} from '@kilocode/cloud-agent-sdk';
import { cloudSessionMessagesPageSchema } from '@kilocode/cloud-agent-sdk/schemas';
import { createTRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import { toFetchedSessionData } from '../fetched-session-data';
import {
  fetchWebCloudSessionSnapshotPage,
  fetchWebSessionSnapshotPage,
} from '../session-page-adapter';
import {
  toCachedTranscriptPage,
  transcriptCacheKey,
  transcriptCacheScope,
} from '../session-transcript-cache';

/** A slow backend must not hold the page; the client loads what the server did not. */
const CHAT_PREFETCH_TIMEOUT_MS = 1500;

/**
 * Seeds the open chat's cached page, so its first client paint shows the
 * transcript and composer settings instead of a loading state.
 */
export async function PrefetchedCloudChat({
  sessionId,
  organizationId,
  children,
}: {
  sessionId: string;
  organizationId: string | null;
  children: ReactNode;
}) {
  const queryClient = new QueryClient();
  try {
    await Promise.race([
      seedCachedTranscript(queryClient, sessionId as KiloSessionId, organizationId),
      new Promise(resolve => setTimeout(resolve, CHAT_PREFETCH_TIMEOUT_MS)),
    ]);
  } catch (error) {
    // The client opens the chat as usual; a chat the server does not know yet
    // or refuses is expected, so only unexpected failures go to Sentry.
    if (!isExpectedSessionReadError(error)) Sentry.captureException(error);
  }
  return <HydrationBoundary state={dehydrate(queryClient)}>{children}</HydrationBoundary>;
}

function isExpectedSessionReadError(error: unknown): boolean {
  return (
    error instanceof TRPCError &&
    (error.code === 'NOT_FOUND' || error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN')
  );
}

type RootCaller = ReturnType<typeof rootRouter.createCaller>;

/**
 * Reads the same first page the browser transport reads, so a Cloud Agent chat
 * is seeded with bounded tool previews rather than complete tool bodies.
 */
async function readFirstPage(
  caller: RootCaller,
  sessionId: KiloSessionId,
  cloudAgentSessionId: string | null,
  organizationId: string | null
): Promise<CachedSessionSnapshotPage | null> {
  if (cloudAgentSessionId?.startsWith('workspace_')) {
    const wirePage = await fetchWebCloudSessionSnapshotPage(
      {
        cloudAgentNext: {
          getSessionMessagesPage: { query: caller.cloudAgentNext.getSessionMessagesPage },
        },
        organizations: {
          cloudAgentNext: {
            getSessionMessagesPage: {
              query: caller.organizations.cloudAgentNext.getSessionMessagesPage,
            },
          },
        },
      },
      cloudAgentSessionId as CloudAgentSessionId,
      organizationId ? { organizationId } : {}
    );
    const page = cloudSessionMessagesPageSchema.parse(wirePage);
    if (!page) return null;
    return {
      info: page.info,
      messages: page.messages,
      nextCursor: page.nextCursor,
      omittedItemCount: page.omittedItemCount,
    };
  }
  const outcome = await fetchWebSessionSnapshotPage(
    {
      cliSessionsV2: {
        getSessionMessagesPage: { query: caller.cliSessionsV2.getSessionMessagesPage },
      },
    },
    sessionId,
    {}
  );
  if (outcome.kind !== 'success') return null;
  const { kind: _kind, ...page } = outcome;
  return page;
}

async function seedCachedTranscript(
  queryClient: QueryClient,
  sessionId: KiloSessionId,
  organizationId: string | null
): Promise<void> {
  const context = await createTRPCContext();
  const caller = rootRouter.createCaller(context);
  const session = await caller.cliSessionsV2.getWithRuntimeState({ session_id: sessionId });
  if (session.organization_id !== organizationId) return;
  const page = await readFirstPage(
    caller,
    sessionId,
    session.cloud_agent_session_id,
    organizationId
  );
  if (!page) return;

  const data = toFetchedSessionData(sessionId, session);
  // Settings are cached only for Cloud Agent sessions, as the SDK caches them.
  const isCloudAgent = data.cloudAgentSessionId !== null && session.runtimeState !== null;
  queryClient.setQueryData(
    transcriptCacheKey(transcriptCacheScope(context.user.id, organizationId), sessionId),
    toCachedTranscriptPage({
      ...page,
      ...(isCloudAgent ? { sessionConfig: sessionConfigFromFetchedSession(sessionId, data) } : {}),
    })
  );
}

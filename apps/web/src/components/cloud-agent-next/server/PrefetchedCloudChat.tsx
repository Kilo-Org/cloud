import 'server-only';
import type { ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { sessionConfigFromFetchedSession, type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { createTRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import { toFetchedSessionData } from '../fetched-session-data';
import { fetchWebSessionSnapshotPage } from '../session-page-adapter';
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
    // The client opens the chat as usual; still report real server failures.
    Sentry.captureException(error);
  }
  return <HydrationBoundary state={dehydrate(queryClient)}>{children}</HydrationBoundary>;
}

async function seedCachedTranscript(
  queryClient: QueryClient,
  sessionId: KiloSessionId,
  organizationId: string | null
): Promise<void> {
  const caller = rootRouter.createCaller(await createTRPCContext());
  const [outcome, session] = await Promise.all([
    fetchWebSessionSnapshotPage(
      {
        cliSessionsV2: {
          getSessionMessagesPage: { query: caller.cliSessionsV2.getSessionMessagesPage },
        },
      },
      sessionId,
      {}
    ),
    caller.cliSessionsV2.getWithRuntimeState({ session_id: sessionId }),
  ]);
  if (outcome.kind !== 'success' || session.organization_id !== organizationId) return;

  const { kind: _kind, ...page } = outcome;
  const data = toFetchedSessionData(sessionId, session);
  // Settings are cached only for Cloud Agent sessions, as the SDK caches them.
  const isCloudAgent = data.cloudAgentSessionId !== null && session.runtimeState !== null;
  queryClient.setQueryData(
    transcriptCacheKey(transcriptCacheScope(organizationId), sessionId),
    toCachedTranscriptPage({
      ...page,
      ...(isCloudAgent ? { sessionConfig: sessionConfigFromFetchedSession(sessionId, data) } : {}),
    })
  );
}

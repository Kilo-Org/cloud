'use client';

import { skipToken, useQuery } from '@tanstack/react-query';
import type { CachedSessionSnapshotPage } from '@kilocode/cloud-agent-sdk';
import { transcriptCacheKey, transcriptCacheScope } from './session-transcript-cache';

/**
 * The cached page of a chat, read while rendering: on the server, it was seeded
 * for the open chat and its signed-in user; on the client, it is the last page
 * that user saw of a recent chat.
 */
export function useCachedTranscriptPage(
  userId: string,
  organizationId: string | null,
  sessionId: string | null
): CachedSessionSnapshotPage | null {
  const { data } = useQuery<CachedSessionSnapshotPage>({
    queryKey: transcriptCacheKey(transcriptCacheScope(userId, organizationId), sessionId ?? ''),
    queryFn: skipToken,
  });
  return sessionId ? (data ?? null) : null;
}

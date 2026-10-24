'use client';

import { skipToken, useQuery } from '@tanstack/react-query';
import type { CachedSessionSnapshotPage } from '@kilocode/cloud-agent-sdk';
import { transcriptCacheKey, transcriptCacheScope } from './session-transcript-cache';

/**
 * The cached page of a chat, read while rendering: on the server, it was seeded
 * for the open chat; on the client, it is the last page seen of a recent chat.
 */
export function useCachedTranscriptPage(
  organizationId: string | null,
  sessionId: string | null
): CachedSessionSnapshotPage | null {
  const { data } = useQuery<CachedSessionSnapshotPage>({
    queryKey: transcriptCacheKey(transcriptCacheScope(organizationId), sessionId ?? ''),
    queryFn: skipToken,
  });
  return sessionId ? (data ?? null) : null;
}

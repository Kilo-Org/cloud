import { useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import type { AttachmentGetUrlResponse, KiloChatClient } from '@kilocode/kilo-chat';

import { attachmentUrlKey } from './query-keys';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function computeAttachmentUrlStaleMs(expiresAtSeconds: number, nowMs: number): number {
  const expiresAtMs = expiresAtSeconds * 1000;
  const remaining = expiresAtMs - nowMs - REFRESH_BUFFER_MS;
  return Math.max(0, remaining);
}

export function isAttachmentUrlValid(expiresAtSeconds: number, nowMs: number): boolean {
  return expiresAtSeconds * 1000 > nowMs;
}

export function attachmentUrlQueryOptions(
  client: KiloChatClient,
  conversationId: string | null,
  attachmentId: string | null,
  options: { enabled?: boolean } = {}
): UseQueryOptions<AttachmentGetUrlResponse> {
  const enabled = options.enabled ?? true;
  return {
    queryKey: attachmentUrlKey(conversationId, attachmentId),
    queryFn: async () => {
      if (!conversationId || !attachmentId) {
        throw new Error('useAttachmentUrl called without ids');
      }
      return client.getAttachmentUrl({ attachmentId, conversationId });
    },
    enabled: enabled && conversationId !== null && attachmentId !== null,
    staleTime: query => {
      const data = query.state.data;
      return data ? computeAttachmentUrlStaleMs(data.expiresAt, Date.now()) : 0;
    },
    // Long-lived tabs would otherwise serve images with signed URLs that
    // expired hours ago. Schedule a refetch just before staleness.
    refetchInterval: query => {
      const data = query.state.data;
      if (!data) return false;
      const ms = computeAttachmentUrlStaleMs(data.expiresAt, Date.now());
      return ms > 0 ? ms : false;
    },
  };
}

export function useAttachmentUrl(
  client: KiloChatClient,
  conversationId: string | null,
  attachmentId: string | null,
  options?: { enabled?: boolean }
): UseQueryResult<AttachmentGetUrlResponse> {
  return useQuery(attachmentUrlQueryOptions(client, conversationId, attachmentId, options));
}

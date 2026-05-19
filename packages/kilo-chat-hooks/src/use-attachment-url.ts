import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { AttachmentGetUrlResponse, KiloChatClient } from '@kilocode/kilo-chat';

import { attachmentUrlKey } from './query-keys';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function computeAttachmentUrlStaleMs(expiresAtSeconds: number, nowMs: number): number {
  const expiresAtMs = expiresAtSeconds * 1000;
  const remaining = expiresAtMs - nowMs - REFRESH_BUFFER_MS;
  return Math.max(0, remaining);
}

export function useAttachmentUrl(
  client: KiloChatClient,
  conversationId: string | null,
  attachmentId: string | null
): UseQueryResult<AttachmentGetUrlResponse> {
  return useQuery({
    queryKey: attachmentUrlKey(conversationId, attachmentId),
    queryFn: async () => {
      if (!conversationId || !attachmentId) {
        throw new Error('useAttachmentUrl called without ids');
      }
      return client.getAttachmentUrl({ attachmentId, conversationId });
    },
    enabled: conversationId !== null && attachmentId !== null,
    staleTime: query => {
      const data = query.state.data;
      return data ? computeAttachmentUrlStaleMs(data.expiresAt, Date.now()) : 0;
    },
    refetchOnWindowFocus: false,
  });
}

'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

export function useAdminCliSessionV2(sessionId: string | null, kiloUserId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.cliSessionsV2.get.queryOptions({
      session_id: sessionId ?? '',
      kilo_user_id: kiloUserId ?? '',
    }),
    enabled: Boolean(sessionId) && Boolean(kiloUserId),
  });
}

'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

export function useAdminSessionTrace(sessionId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.sessionTraces.get.queryOptions({ session_id: sessionId ?? '' }),
    enabled: !!sessionId,
  });
}

export function useAdminSessionMessages(sessionId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.sessionTraces.getMessages.queryOptions({ session_id: sessionId ?? '' }),
    enabled: !!sessionId,
  });
}

export function useAdminApiConversationHistory(sessionId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.sessionTraces.getApiConversationHistory.queryOptions({
      session_id: sessionId ?? '',
    }),
    enabled: !!sessionId,
  });
}

export function useAdminResolveCloudAgentSession(cloudAgentSessionId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.sessionTraces.resolveCloudAgentSession.queryOptions({
      cloud_agent_session_id: cloudAgentSessionId ?? '',
    }),
    enabled: !!cloudAgentSessionId,
  });
}

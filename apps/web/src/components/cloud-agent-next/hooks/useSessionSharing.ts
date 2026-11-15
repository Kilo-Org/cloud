import { skipToken, useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { getSessionSharingDisabledReason } from '../session-sharing';

export function useSessionSharing({
  kiloSessionId,
  cloudAgentSessionId,
  organizationId,
  enabled,
}: {
  kiloSessionId?: string;
  cloudAgentSessionId?: string | null;
  organizationId?: string;
  enabled: boolean;
}) {
  const trpc = useTRPC();
  const input =
    enabled && kiloSessionId && cloudAgentSessionId?.startsWith('workspace_')
      ? { sessionId: cloudAgentSessionId, kiloSessionId, limit: 1 }
      : undefined;
  const options = organizationId
    ? trpc.organizations.cloudAgentNext.getSessionMessagesPage.queryOptions(
        input ? { ...input, organizationId } : skipToken
      )
    : trpc.cloudAgentNext.getSessionMessagesPage.queryOptions(input ?? skipToken);
  const history = useQuery({ ...options, retry: 1 });

  return getSessionSharingDisabledReason({
    kiloSessionId,
    cloudAgentSessionId,
    history: history.data,
    isError: history.isError,
  });
}

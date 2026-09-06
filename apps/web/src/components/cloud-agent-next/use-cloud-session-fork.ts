'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import {
  runCloudForkFlow,
  buildCloudChatSessionPath,
  type CloudSessionForkCreateInput,
} from './cloud-session-fork';
import { invalidateSessionQueries } from './session-deletion';

/**
 * Fork a source session into a brand-new Cloud Agent session and navigate to
 * it. `organizationId` is the context the caller renders in (personal when
 * omitted, an organization otherwise) and decides both which `prepareSession`
 * endpoint runs and where the new session opens.
 */
export function useCloudSessionFork(organizationId?: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const [forkingSessionId, setForkingSessionId] = useState<string | null>(null);

  const forkSessionToNewCloudSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      setForkingSessionId(sessionId);
      try {
        const operationKey = crypto.randomUUID();
        const createSession = organizationId
          ? (input: CloudSessionForkCreateInput) =>
              trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
                ...input,
                organizationId,
              })
          : (input: CloudSessionForkCreateInput) =>
              trpcClient.cloudAgentNext.prepareSession.mutate(input);

        return await runCloudForkFlow({
          sessionId,
          organizationId,
          operationKey,
          deps: {
            getRuntimeState: async id => {
              const result = await trpcClient.cliSessionsV2.getWithRuntimeState.query({
                session_id: id,
              });
              return {
                session: {
                  session_id: result.session_id,
                  cloud_agent_session_id: result.cloud_agent_session_id,
                  organization_id: result.organization_id,
                },
                runtimeState: result.runtimeState,
              };
            },
            createSession,
            invalidateSessionQueries: () => invalidateSessionQueries({ queryClient, trpc }),
            navigateToSession: (kiloSessionId: string) =>
              router.push(buildCloudChatSessionPath(organizationId, kiloSessionId)),
            notifyError: message => toast.error(message),
          },
        });
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : 'Failed to fork the session into a new Cloud Agent session';
        toast.error(message);
        return false;
      } finally {
        setForkingSessionId(null);
      }
    },
    [organizationId, queryClient, router, trpc, trpcClient]
  );

  return { forkSessionToNewCloudSession, forkingSessionId };
}

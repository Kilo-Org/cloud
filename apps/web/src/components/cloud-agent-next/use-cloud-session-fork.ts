'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { toast } from 'sonner';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import {
  runCloudForkFlow,
  buildCloudChatSessionPath,
  type CloudSessionForkCreateInput,
} from './cloud-session-fork';
import { invalidateSessionQueries } from './session-deletion';

/**
 * tRPC error code from a thrown client error, following the established
 * `error.data?.code ?? error.shape?.data?.code` pattern.
 */
function readForkErrorCode(error: unknown): string | undefined {
  if (error instanceof TRPCClientError) {
    return error.data?.code ?? error.shape?.data?.code;
  }
  return undefined;
}

/**
 * Fork a source session into a brand-new Cloud Agent session and navigate to
 * it. `organizationId` is the context the caller renders in (personal when
 * omitted, an organization otherwise) and decides both which `prepareSession`
 * endpoint runs and where the new session opens.
 *
 * Idempotency is best-effort: the key is held in memory so an in-page retry
 * after an ambiguous failure replays the same create, but a page reload mints
 * a fresh key and may duplicate the session.
 */
export function useCloudSessionFork(organizationId?: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const [forkingSessionId, setForkingSessionId] = useState<string | null>(null);
  // Reuse one `operationKey` per (context, session) while an attempt may have
  // committed server-side: after an ambiguous failure a retry with the same
  // key replays the settled create instead of minting a second session. The
  // key rotates once the fork reports a settled outcome. Typed rejections
  // return `false` from the flow without a create call, so they settle too.
  const pendingOperationRef = useRef<{ fingerprint: string; operationKey: string } | null>(null);

  const forkSessionToNewCloudSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      setForkingSessionId(sessionId);
      const fingerprint = `${organizationId ?? 'personal'}:${sessionId}`;
      const pending = pendingOperationRef.current;
      const operationKey =
        pending?.fingerprint === fingerprint ? pending.operationKey : crypto.randomUUID();
      pendingOperationRef.current = { fingerprint, operationKey };

      const rotateOperationKey = () => {
        if (pendingOperationRef.current?.fingerprint === fingerprint) {
          pendingOperationRef.current = null;
        }
      };

      try {
        const createSession = organizationId
          ? (input: CloudSessionForkCreateInput) =>
              trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
                ...input,
                organizationId,
              })
          : (input: CloudSessionForkCreateInput) =>
              trpcClient.cloudAgentNext.prepareSession.mutate(input);

        const settled = await runCloudForkFlow({
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
        if (settled) {
          rotateOperationKey();
        }
        return settled;
      } catch (error) {
        // The error is ambiguous: the server may have committed the create but
        // the response was lost. Keep the operation key so a user retry replays
        // the same intent instead of duplicating the session. A missing or
        // unreadable source session cannot have committed anything, but
        // reusing the key there is harmless.
        console.error('Failed to fork session into a new Cloud Agent session:', error);
        const code = readForkErrorCode(error);
        if (code === 'NOT_FOUND') {
          toast.error('This session no longer exists, so it cannot be forked.');
        } else if (code === 'FORBIDDEN') {
          toast.error('You do not have access to fork this session.');
        } else {
          toast.error(
            'Failed to fork the session into a new Cloud Agent session. Please try again.'
          );
        }
        return false;
      } finally {
        setForkingSessionId(null);
      }
    },
    [organizationId, queryClient, router, trpc, trpcClient]
  );

  return { forkSessionToNewCloudSession, forkingSessionId };
}

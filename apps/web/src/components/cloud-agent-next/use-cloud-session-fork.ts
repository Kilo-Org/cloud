'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { toast } from 'sonner';
import { CLOUD_AGENT_METADATA_STALE_TIME } from '@/lib/cloud-agent/constants';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import {
  runCloudForkFlow,
  buildCloudChatSessionPath,
  isGitHubForkUrl,
  parsePendingCloudClone,
  type CloudSessionForkCreateInput,
  type ReadOnlyForkSettings,
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

const CLONE_REFUSAL_CODES = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'PAYMENT_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'PRECONDITION_FAILED',
  'UNPROCESSABLE_CONTENT',
]);

const CONTINUATION_STORAGE_ERROR = new Error(
  'Could not save this request. Allow browser storage and try again.'
);

function readPendingClone(
  storageKey: string,
  sessionId: string
): CloudSessionForkCreateInput | undefined {
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (!stored) return undefined;
    const input = parsePendingCloudClone(stored, sessionId);
    if (!input) throw CONTINUATION_STORAGE_ERROR;
    return input;
  } catch {
    throw CONTINUATION_STORAGE_ERROR;
  }
}

function clearPendingClone(storageKey: string) {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Replaying a completed request remains safe if cleanup fails.
  }
}

/**
 * Fork a source session into a brand-new Cloud Agent session and navigate to
 * it. `organizationId` is the context the caller renders in (personal when
 * omitted, an organization otherwise) and decides both which `prepareSession`
 * endpoint runs and where the new session opens.
 *
 * For read-only continuation, keep the exact create request across reloads.
 */
export function useCloudSessionFork(organizationId?: string, currentUserId?: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const [forkingSessionId, setForkingSessionId] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Reuse one `operationKey` per (context, session) while an attempt may have
  // committed server-side: after an ambiguous failure a retry with the same
  // key replays the settled create instead of minting a second session. The
  // key rotates after a successful create.
  const pendingOperationRef = useRef<{
    fingerprint: string;
    operationKey: string;
  } | null>(null);

  const forkSessionToNewCloudSession = useCallback(
    async (sessionId: string, readOnlySettings?: ReadOnlyForkSettings): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setForkingSessionId(sessionId);
      const fingerprint = `${organizationId ?? 'personal'}:${sessionId}`;
      const storageKey =
        readOnlySettings && currentUserId
          ? `cloud-session-continuation:${currentUserId}:${fingerprint}`
          : undefined;
      let sentNewClone = false;

      try {
        const pending =
          !readOnlySettings && pendingOperationRef.current?.fingerprint === fingerprint
            ? pendingOperationRef.current
            : undefined;
        const pendingInput = storageKey ? readPendingClone(storageKey, sessionId) : undefined;
        const operationKey =
          pendingInput?.operationKey ?? pending?.operationKey ?? crypto.randomUUID();
        if (!readOnlySettings) pendingOperationRef.current = { fingerprint, operationKey };

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
          pendingInput,
          getReadOnlySettings: readOnlySettings
            ? async gitUrl => {
                const [{ data }, gitLabInstanceUrl] = await Promise.all([
                  queryClient.fetchQuery(
                    trpc.models.selectorList.queryOptions(
                      { organizationId, audience: 'member' },
                      { staleTime: CLOUD_AGENT_METADATA_STALE_TIME }
                    )
                  ),
                  isGitHubForkUrl(gitUrl)
                    ? undefined
                    : trpcClient.gitlab.getInstallation
                        .query({ organizationId })
                        .then(result =>
                          result.installed ? result.installation?.instanceUrl : undefined
                        ),
                ]);
                const model = data.find(option => option.id === readOnlySettings.model) ?? data[0];
                const variant = readOnlySettings.variant;
                return {
                  mode: readOnlySettings.mode,
                  model: model?.id,
                  gitLabInstanceUrl,
                  variant:
                    variant &&
                    model?.id === readOnlySettings.model &&
                    Object.hasOwn(model?.opencode?.variants ?? {}, variant)
                      ? variant
                      : undefined,
                };
              }
            : undefined,
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
                  git_url: result.git_url,
                },
                runtimeState: result.runtimeState,
              };
            },
            createSession: async input => {
              if (readOnlySettings) {
                try {
                  if (!storageKey) throw CONTINUATION_STORAGE_ERROR;
                  sessionStorage.setItem(storageKey, JSON.stringify(input));
                } catch {
                  throw CONTINUATION_STORAGE_ERROR;
                }
                sentNewClone = pendingInput === undefined;
              }
              const result = await createSession(input);
              if (input.workspaceContinuation && !result.worktreeId) {
                throw new Error('Workspace continuation returned no worktree');
              }
              return result;
            },
            invalidateSessionQueries: () => invalidateSessionQueries({ queryClient, trpc }),
            navigateToSession: (kiloSessionId: string) =>
              router.push(buildCloudChatSessionPath(organizationId, kiloSessionId)),
            notifyError: message => toast.error(message),
          },
        });
        if (settled) {
          if (!readOnlySettings) pendingOperationRef.current = null;
          if (storageKey) clearPendingClone(storageKey);
        }
        return settled;
      } catch (error) {
        // The error is ambiguous: the server may have committed the create but
        // the response was lost. Keep the operation key so a user retry replays
        // the same intent instead of duplicating the session. A missing or
        // unreadable source session cannot have committed anything, but
        // reusing the key there is harmless.
        const code = readForkErrorCode(error);
        const settledFailure =
          code === 'BAD_REQUEST' &&
          error instanceof TRPCClientError &&
          error.message === 'session_creation_failed';
        if (
          readOnlySettings &&
          (settledFailure || (sentNewClone && code && CLONE_REFUSAL_CODES.has(code)))
        ) {
          if (storageKey) clearPendingClone(storageKey);
        }
        if (error === CONTINUATION_STORAGE_ERROR) {
          toast.error(CONTINUATION_STORAGE_ERROR.message);
        } else if (settledFailure) {
          toast.error('Cloud Agent could not create the workspace. Please try again.');
        } else if (code === 'NOT_FOUND') {
          toast.error('This session no longer exists, so it cannot be forked.');
        } else if (code === 'FORBIDDEN') {
          toast.error('You do not have access to fork this session.');
        } else if (
          readOnlySettings &&
          code &&
          CLONE_REFUSAL_CODES.has(code) &&
          error instanceof TRPCClientError
        ) {
          toast.error(error.message);
        } else {
          toast.error(
            'Failed to fork the session into a new Cloud Agent session. Please try again.'
          );
        }
        return false;
      } finally {
        inFlight.current = false;
        setForkingSessionId(null);
      }
    },
    [currentUserId, organizationId, queryClient, router, trpc, trpcClient]
  );

  return { forkSessionToNewCloudSession, forkingSessionId };
}

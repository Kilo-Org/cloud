/* eslint-disable max-lines -- 333 lines: cloud prepare and remote spawn key rotation stay in the one continue hook. */
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useCallback, useRef, useState } from 'react';
import { type Href, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useStore } from 'jotai';
import { toast } from 'sonner-native';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import * as Haptics from 'expo-haptics';
import { listInstanceModels } from '@kilocode/cloud-agent-sdk/instance-model-catalog';

import {
  buildContinuationSeed,
  buildContinueRemoteSpawnInput,
  type ContinuationDestination,
  resolveContinuationDestinations,
} from '@/components/agents/continuation-seed';
import { setContinuePickerBridge } from '@/components/agents/continue-picker-bridge';
import { normalizeAgentMode } from '@/components/agents/mode-options';
import { isCloudPrepareRetryableError } from '@/components/agents/mobile-session-manager';
import {
  appendNewSessionPrefill,
  buildContinuePrefillParams,
} from '@/components/agents/new-session-prefill';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import {
  getAgentSessionPath,
  getSpawnedAgentSessionPath,
} from '@/components/agents/session-detail-routes';
import { type useSessionManager } from '@/components/agents/session-provider';
import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { putSharePayload } from '@/lib/share-payload';
import { appendShareParams } from '@/lib/share-navigation';
import { useRemoteInstanceSpawn } from '@/lib/hooks/use-remote-instance-spawn';
import { useHoistedOperationKey } from '@/lib/operation-key';
import {
  REMOTE_SPAWN_NON_RETRYABLE_TOAST,
  REMOTE_SPAWN_RETRYABLE_TOAST,
} from '@/lib/remote-submit-outcome';
import { captureEvent, SESSION_CREATED_EVENT } from '@/lib/analytics/posthog';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { trpcClient, useTRPC } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type RepositoriesResult =
  | RouterOutputs['organizations']['cloudAgentNext']['listGitHubRepositories']
  | RouterOutputs['cloudAgentNext']['listGitHubRepositories'];
type InstancesResult = RouterOutputs['activeSessions']['listInstances'];

export function useContinueSession(args: {
  organizationId: string | undefined;
  manager: ReturnType<typeof useSessionManager>;
  models: SessionModelOption[];
  modelsLoading: boolean;
}): {
  continueSession: (input: {
    gitUrl: string | null | undefined;
    mode: string;
    model: string;
    variant: string;
  }) => Promise<void>;
  isContinuing: boolean;
} {
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const store = useStore();
  const connection = useUserWebConnection();
  const { spawn } = useRemoteInstanceSpawn(args.organizationId ?? null);
  const [isContinuing, setIsContinuing] = useState(false);
  const busyRef = useRef(false);
  // P1-A-08b: cloud prepares and remote spawns are different intents, so each
  // destination family holds its own hoisted `operationKey`.
  const cloudOperationKey = useHoistedOperationKey();
  const remoteOperationKey = useHoistedOperationKey();

  const runCloudCreate = useCallback(
    async (seed: string, dest: { repo: string; model: string; variant: string }, mode: string) => {
      const intentFingerprint = JSON.stringify({
        seed,
        repo: dest.repo,
        model: dest.model,
        variant: dest.variant || undefined,
        mode,
        organizationId: args.organizationId ?? null,
      });
      const operationKey = cloudOperationKey.getKey(intentFingerprint);
      const initialMessageId = generateMessageId();
      const baseInput = {
        prompt: seed,
        initialMessageId,
        mode: normalizeAgentMode(mode),
        model: dest.model,
        variant: dest.variant || undefined,
        githubRepo: dest.repo,
        autoCommit: true,
        autoInitiate: true,
        operationKey,
      };
      try {
        const result = args.organizationId
          ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
              ...baseInput,
              organizationId: args.organizationId,
            })
          : await trpcClient.cloudAgentNext.prepareSession.mutate(baseInput);
        // The intent settled; the next submit is a fresh intent. Rotate
        // before the post-success work so a UI failure cannot keep the
        // successful key for a retry or rotate it a second time.
        cloudOperationKey.rotateKey();

        // The cloud session already exists, so no post-success UI failure may
        // report the create as failed or invite a duplicate retry. Each step is
        // contained on its own so one failure cannot skip the navigation.
        try {
          captureEvent(SESSION_CREATED_EVENT, { surface: 'cloud-agent' });
        } catch {
          // Analytics is best-effort; stay silent.
        }
        try {
          await invalidateAgentSessionQueries(queryClient, trpc);
        } catch {
          // A failed cache invalidation is cosmetic; navigation must still run.
        }
        try {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch {
          // A failed haptics call is cosmetic; stay silent and navigate.
        }
        try {
          router.push(getAgentSessionPath(result.kiloSessionId, args.organizationId));
        } catch {
          // A navigation failure is not a create failure.
        }
      } catch (error) {
        // Only `prepareSession` errors reach here; UI failures are contained
        // above. A typed terminal rejection ends the intent.
        if (!isCloudPrepareRetryableError(error)) {
          cloudOperationKey.rotateKey();
        }
        throw error;
      }
    },
    [args.organizationId, queryClient, router, trpc, cloudOperationKey]
  );

  const execute = useCallback(
    async (
      dest: ContinuationDestination,
      seed: string,
      fields: { mode: string; model: string; variant: string }
    ) => {
      setIsContinuing(true);
      busyRef.current = true;
      try {
        if (dest.kind === 'cloud-agent') {
          try {
            await runCloudCreate(seed, dest, fields.mode);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to create session');
          }
          return;
        }
        const remoteOperationKeyValue = remoteOperationKey.getKey(
          JSON.stringify({
            connectionId: dest.instance.connectionId,
            seed,
            model: fields.model,
            variant: fields.variant,
            mode: fields.mode,
            organizationId: args.organizationId ?? null,
          })
        );
        const catalogResult = await listInstanceModels(connection, dest.instance.connectionId);
        const outcome = await spawn(
          dest.instance.connectionId,
          buildContinueRemoteSpawnInput({
            mode: fields.mode,
            model: fields.model,
            variant: fields.variant,
            options: args.models,
            catalogResult,
            organizationId: args.organizationId,
          }),
          { operationKey: remoteOperationKeyValue }
        );
        if (outcome.status === 'ready') {
          // The spawn settled; the next submit is a fresh intent.
          remoteOperationKey.rotateKey();
          const shareId = putSharePayload({ text: seed, files: [], failedFiles: [] });
          router.push(
            appendShareParams(
              getSpawnedAgentSessionPath(outcome.sessionID, args.organizationId) as string,
              shareId,
              { autoSend: true }
            ) as Href
          );
          return;
        }
        toast.error(
          outcome.status === 'retryable'
            ? REMOTE_SPAWN_RETRYABLE_TOAST
            : REMOTE_SPAWN_NON_RETRYABLE_TOAST
        );
        // A non-retryable rejection ends the intent; a retryable outcome keeps
        // the key so a same-key retry dedupes on the relay.
        if (outcome.status === 'nonRetryable') {
          remoteOperationKey.rotateKey();
        }
      } finally {
        busyRef.current = false;
        setIsContinuing(false);
      }
    },
    [
      args.organizationId,
      args.models,
      connection,
      router,
      runCloudCreate,
      spawn,
      remoteOperationKey,
    ]
  );

  const fallback = useCallback(
    (
      fields: { gitUrl: string | null | undefined; mode: string; model: string; variant: string },
      seed: string | null
    ) => {
      let path = appendNewSessionPrefill(
        getNewAgentSessionPath(args.organizationId ?? null),
        buildContinuePrefillParams({
          gitUrl: fields.gitUrl,
          mode: fields.mode,
          model: fields.model,
          variant: fields.variant,
        })
      );
      if (seed !== null) {
        const shareId = putSharePayload({ text: seed, files: [], failedFiles: [] });
        path = appendShareParams(path, shareId);
      }
      router.push(path as Href);
    },
    [args.organizationId, router]
  );

  const continueSession = useCallback(
    async (fields: {
      gitUrl: string | null | undefined;
      mode: string;
      model: string;
      variant: string;
    }) => {
      if (busyRef.current) {
        return;
      }
      setIsContinuing(true);
      busyRef.current = true;
      let handedOff = false;
      try {
        for (
          let pages = 0;
          pages < 10 && store.get(args.manager.atoms.hasOlderMessages);
          pages += 1
        ) {
          const before = store.get(args.manager.atoms.messagesList).length;
          // eslint-disable-next-line no-await-in-loop -- draining pages sequentially is the intended behavior
          await args.manager.loadOlderMessages();
          if (store.get(args.manager.atoms.messagesList).length === before) {
            break;
          }
        }
        const messages = store.get(args.manager.atoms.messagesList);
        const seed = buildContinuationSeed(messages);

        if (seed === null) {
          fallback(fields, null);
          return;
        }

        let repoData: RepositoriesResult | undefined = undefined;
        let instancesData: InstancesResult | undefined = undefined;
        try {
          [repoData, instancesData] = await Promise.all([
            queryClient.fetchQuery({
              ...(args.organizationId
                ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
                    organizationId: args.organizationId,
                    forceRefresh: false,
                  })
                : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
                    forceRefresh: false,
                  })),
              staleTime: 0,
            }),
            queryClient.fetchQuery({
              ...trpc.activeSessions.listInstances.queryOptions(undefined),
              staleTime: 5000,
            }),
          ]);
        } catch {
          fallback(fields, seed);
          return;
        }

        const destinations = resolveContinuationDestinations({
          gitUrl: fields.gitUrl,
          mode: fields.mode,
          model: fields.model,
          variant: fields.variant,
          repositories: repoData.repositories,
          models: args.modelsLoading ? [] : args.models,
          instances: instancesData.instances,
        });

        if (destinations.length === 0) {
          fallback(fields, seed);
          return;
        }

        if (destinations.length === 1) {
          const dest = destinations[0];
          if (!dest) {
            fallback(fields, seed);
            return;
          }
          await execute(dest, seed, fields);
          return;
        }

        handedOff = true;
        const release = () => {
          busyRef.current = false;
          setIsContinuing(false);
        };
        setContinuePickerBridge({
          destinations,
          onSelect: dest => {
            void execute(dest, seed, fields);
          },
          onCancel: release,
        });
        router.push('/(app)/agent-chat/continue-picker' as Href);
      } finally {
        if (!handedOff) {
          busyRef.current = false;
          setIsContinuing(false);
        }
      }
    },
    [
      args.manager,
      args.models,
      args.modelsLoading,
      args.organizationId,
      store,
      fallback,
      queryClient,
      trpc,
      execute,
      router,
    ]
  );

  return { continueSession, isContinuing };
}

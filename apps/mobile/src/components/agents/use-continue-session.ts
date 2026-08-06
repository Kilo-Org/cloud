/* eslint-disable max-lines -- cloud prepare and remote spawn key rotation stay in the one continue hook. */
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useCallback, useRef, useState } from 'react';
import { type Href, useRouter } from 'expo-router';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQueryClient } from '@tanstack/react-query';
import { useStore } from 'jotai';
import { toast } from 'sonner-native';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import * as Haptics from 'expo-haptics';

import {
  buildContinuationSeed,
  type ContinuationDestination,
  resolveContinuationDestinations,
  resolveContinueRemoteModel,
} from '@/components/agents/continuation-seed';
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
import { putSharePayload } from '@/lib/share-payload';
import { appendShareParams } from '@/lib/share-navigation';
import {
  buildCreateRemoteSessionInput,
  useRemoteInstanceSpawn,
} from '@/lib/hooks/use-remote-instance-spawn';
import { useHoistedOperationKey } from '@/lib/pr-review/merge/pr-operation-ledger';
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
  models: { id: string; variants: string[] }[];
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
  const { showActionSheetWithOptions } = useActionSheet();
  const { spawn } = useRemoteInstanceSpawn(args.organizationId ?? null);
  const [isContinuing, setIsContinuing] = useState(false);
  const busyRef = useRef(false);
  // P1-A-08b: one hoisted `operationKey` per submit intent for each
  // destination family. Cloud prepares and remote spawns are different
  // intents, so they never share a key; each is kept across retryable
  // failures and rotated on success or a typed terminal rejection.
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
        // The intent settled; the next submit is a fresh intent.
        cloudOperationKey.rotateKey();
        captureEvent(SESSION_CREATED_EVENT, { surface: 'cloud-agent' });
        await invalidateAgentSessionQueries(queryClient, trpc);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.push(getAgentSessionPath(result.kiloSessionId, args.organizationId));
      } catch (error) {
        // A typed terminal rejection ends the intent; retryable failures
        // (transport and `creation_in_progress`) keep the key.
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
        const remoteModel = resolveContinueRemoteModel(fields.model, fields.variant, args.models);
        const remoteOperationKeyValue = remoteOperationKey.getKey(
          JSON.stringify({
            connectionId: dest.instance.connectionId,
            seed,
            model: remoteModel.model || undefined,
            variant: remoteModel.variant || undefined,
            mode: fields.mode,
            organizationId: args.organizationId ?? null,
          })
        );
        const outcome = await spawn(
          dest.instance.connectionId,
          buildCreateRemoteSessionInput({
            mode: fields.mode,
            model: remoteModel.model,
            variant: remoteModel.variant,
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
        // A typed non-retryable spawn rejection ends the intent; retryable
        // outcomes keep the key so a same-key retry dedupes on the relay.
        if (outcome.status === 'nonRetryable') {
          remoteOperationKey.rotateKey();
        }
      } finally {
        busyRef.current = false;
        setIsContinuing(false);
      }
    },
    [args.organizationId, args.models, router, runCloudCreate, spawn, remoteOperationKey]
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
        const labels = destinations.map(d =>
          d.kind === 'cloud-agent' ? 'Cloud Agent' : d.instance.name
        );
        showActionSheetWithOptions(
          {
            title: 'Continue in a new session',
            options: [...labels, 'Cancel'],
            cancelButtonIndex: labels.length,
          },
          selected => {
            if (selected === undefined || selected >= labels.length) {
              busyRef.current = false;
              setIsContinuing(false);
              return;
            }
            const dest = destinations[selected];
            if (!dest) {
              busyRef.current = false;
              setIsContinuing(false);
              return;
            }
            void execute(dest, seed, fields);
          }
        );
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
      showActionSheetWithOptions,
    ]
  );

  return { continueSession, isContinuing };
}

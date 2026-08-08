import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useCallback, useRef, useState } from 'react';
import { type Href, useRouter } from 'expo-router';
import { useActionSheet } from '@expo/react-native-action-sheet';
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
import { normalizeAgentMode } from '@/components/agents/mode-options';
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
  const { showActionSheetWithOptions } = useActionSheet();
  const { spawn } = useRemoteInstanceSpawn(args.organizationId ?? null);
  const [isContinuing, setIsContinuing] = useState(false);
  const busyRef = useRef(false);

  const runCloudCreate = useCallback(
    async (seed: string, dest: { repo: string; model: string; variant: string }, mode: string) => {
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
      };
      const result = args.organizationId
        ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            organizationId: args.organizationId,
          })
        : await trpcClient.cloudAgentNext.prepareSession.mutate(baseInput);
      captureEvent(SESSION_CREATED_EVENT, { surface: 'cloud-agent' });
      await invalidateAgentSessionQueries(queryClient, trpc);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.push(getAgentSessionPath(result.kiloSessionId, args.organizationId));
    },
    [args.organizationId, queryClient, router, trpc]
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
          })
        );
        if (outcome.status === 'ready') {
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
      } finally {
        busyRef.current = false;
        setIsContinuing(false);
      }
    },
    [args.organizationId, args.models, connection, router, runCloudCreate, spawn]
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

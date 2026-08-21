import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useCallback, useRef, useState } from 'react';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import {
  type ContinuationDestination,
  resolveContinuationDestinations,
} from '@/components/agents/continuation-seed';
import { useContinueCloudCreate } from '@/components/agents/use-continue-cloud-create';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { useTRPC } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type RepositoriesResult =
  | RouterOutputs['organizations']['cloudAgentNext']['listGitHubRepositories']
  | RouterOutputs['cloudAgentNext']['listGitHubRepositories'];

const FULL_CONTINUATION_UNAVAILABLE_TOAST = 'Full continuation is unavailable for this session.';

export function useContinueSession(args: {
  sessionId: KiloSessionId;
  organizationId: string | undefined;
  models: SessionModelOption[];
  modelsLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [isContinuing, setIsContinuing] = useState(false);
  const busyRef = useRef(false);
  const runCloudCreate = useContinueCloudCreate(args.organizationId);

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
      try {
        let repoData: RepositoriesResult | undefined = undefined;
        try {
          repoData = await queryClient.fetchQuery({
            ...(args.organizationId
              ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
                  organizationId: args.organizationId,
                  forceRefresh: false,
                })
              : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
                  forceRefresh: false,
                })),
            staleTime: 0,
          });
        } catch {
          toast.error(FULL_CONTINUATION_UNAVAILABLE_TOAST);
          return;
        }

        const destinations = resolveContinuationDestinations({
          gitUrl: fields.gitUrl,
          mode: fields.mode,
          model: fields.model,
          variant: fields.variant,
          repositories: repoData.repositories,
          models: args.modelsLoading ? [] : args.models,
        });

        const dest: ContinuationDestination | undefined = destinations[0];
        if (dest?.kind !== 'cloud-agent') {
          toast.error(FULL_CONTINUATION_UNAVAILABLE_TOAST);
          return;
        }

        try {
          await runCloudCreate(args.sessionId, dest, fields.mode);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Failed to create session');
        }
      } finally {
        busyRef.current = false;
        setIsContinuing(false);
      }
    },
    [
      args.organizationId,
      args.models,
      args.modelsLoading,
      args.sessionId,
      queryClient,
      trpc,
      runCloudCreate,
    ]
  );

  return { continueSession, isContinuing };
}

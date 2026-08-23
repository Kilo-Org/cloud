import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { useQueryClient } from '@tanstack/react-query';

import { resolveContinuationResolution } from '@/components/agents/continuation-seed';
import { isCloudPrepareRetryableError } from '@/components/agents/mobile-session-manager';
import { useContinueCloudCreate } from '@/components/agents/use-continue-cloud-create';
import { i18n } from '@/i18n';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { useTRPC } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type RepositoriesResult =
  | RouterOutputs['organizations']['cloudAgentNext']['listGitHubRepositories']
  | RouterOutputs['cloudAgentNext']['listGitHubRepositories'];

// Six clone attempts with the five gaps between them. The sixth retryable
// failure ends the intent with persistent retry guidance.
const CONTINUE_RETRY_DELAYS_MS: number[] = [500, 1000, 2000, 4000, 5000];

export type ContinueSessionGuidance =
  | {
      kind: 'terminal';
      action: 'back-to-sessions' | 'connect-repository';
      message: string;
    }
  | { kind: 'retry'; message: string }
  | null;

const defaultContinueSleep = async (ms: number): Promise<void> => {
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
};

export function useContinueSession(args: {
  sessionId: KiloSessionId;
  organizationId: string | undefined;
  models: SessionModelOption[];
  modelsLoading: boolean;
  sleep?: (ms: number) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [isContinuing, setIsContinuing] = useState(false);
  const [guidance, setGuidance] = useState<ContinueSessionGuidance>(null);
  const busyRef = useRef(false);
  const runCloudCreate = useContinueCloudCreate(args.organizationId);
  const sleep = args.sleep ?? defaultContinueSleep;

  // A source-session change ends the previous intent's guidance.
  useEffect(() => {
    setGuidance(null);
  }, [args.sessionId]);

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
      setGuidance(null);
      try {
        if (args.modelsLoading) {
          // The destination model cannot resolve until the catalog loads.
          // Return retry guidance so Continue stays enabled; never resolve a
          // destination against an empty model list.
          setGuidance({ kind: 'retry', message: i18n.t('agentChat.session.cloneFailedRetry') });
          return;
        }
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
          setGuidance({ kind: 'retry', message: i18n.t('agentChat.session.cloneFailedRetry') });
          return;
        }

        const resolution = resolveContinuationResolution({
          gitUrl: fields.gitUrl,
          mode: fields.mode,
          model: fields.model,
          variant: fields.variant,
          repositories: repoData.repositories,
          models: args.models,
        });

        if (resolution.kind === 'unmatched-repository') {
          setGuidance({
            kind: 'terminal',
            action: 'connect-repository',
            message: i18n.t('agentChat.session.connectRepositoryToContinue'),
          });
          return;
        }

        if (resolution.kind === 'unresolved-model') {
          setGuidance({
            kind: 'terminal',
            action: 'back-to-sessions',
            message: i18n.t('agentChat.session.cloneFailed'),
          });
          return;
        }

        const dest = resolution;

        for (let attempt = 0; ; attempt += 1) {
          try {
            // eslint-disable-next-line no-await-in-loop -- clone retry backoff cadence
            await runCloudCreate(args.sessionId, dest, fields.mode);
            return;
          } catch (error) {
            if (!isCloudPrepareRetryableError(error)) {
              setGuidance({
                kind: 'terminal',
                action: 'back-to-sessions',
                message: i18n.t('agentChat.session.cloneFailed'),
              });
              return;
            }
            const delay = CONTINUE_RETRY_DELAYS_MS[attempt];
            if (delay === undefined) {
              // The sixth retryable failure ends the intent; Continue stays
              // enabled so the user can retry the same operation key.
              setGuidance({ kind: 'retry', message: i18n.t('agentChat.session.cloneFailedRetry') });
              return;
            }
            // eslint-disable-next-line no-await-in-loop -- clone retry backoff cadence
            await sleep(delay);
          }
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
      sleep,
    ]
  );

  const clearGuidance = useCallback(() => {
    setGuidance(null);
  }, []);

  return { continueSession, isContinuing, guidance, clearGuidance };
}

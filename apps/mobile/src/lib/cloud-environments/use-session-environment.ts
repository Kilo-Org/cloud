import { useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { type NewSessionRepository } from '@/components/agents/new-session-repository-state';
import {
  chosenEnvironmentId,
  environmentChoiceKey,
  type EnvironmentSelection,
  type EnvironmentSummaryRow,
  selectedEnvironment,
  selectEnvironment,
  toEnvironmentRepositoryInput,
} from '@/lib/cloud-environments/environment-selection';
import {
  type EnvironmentBuildStatusRow,
  isBuildActive,
} from '@/lib/cloud-environments/environment-build-copy';
import { usePersistedEnvironmentChoice } from '@/lib/hooks/environment-choice';
import { useTRPC } from '@/lib/trpc';

/** Never fetched: the list query is disabled until the repository resolves. */
const NO_REPOSITORY = { platform: 'github', fullName: '' } as const;

/** While a build runs, its stage changes without a person asking. */
const BUILD_POLL_MS = 3_000;

/** Everything the new-session form reads about the repository's environments. */
export type SessionEnvironment = {
  /** Every environment that contains the repository; undefined while unknown. */
  matches: EnvironmentSummaryRow[] | undefined;
  /** The list failed to load; a retry re-reads it. */
  isError: boolean;
  retryEnvironmentList: () => void;
  selection: EnvironmentSelection;
  /** The environment the session uses: null when none, undefined while unknown. */
  environment: EnvironmentSummaryRow | null | undefined;
  buildStatusFor: (environmentId: string) => EnvironmentBuildStatusRow | undefined;
  /** This environment's build status read failed; its views show that, not a load. */
  buildStatusFailedFor: (environmentId: string) => boolean;
  /** Re-reads every match's build status. */
  retryBuildStatus: () => void;
  chooseEnvironment: (environmentId: string) => void;
};

/**
 * The cloud environment of a new session in the selected repository: the
 * environments that contain it, the remembered pick among several, and each
 * one's snapshot build.
 *
 * The choice is remembered per repository and scope, the way the web's
 * `useSessionEnvironment` remembers it, so returning to a repository restores
 * the environment picked for it.
 */
export function useSessionEnvironment({
  organizationId,
  repository,
}: {
  organizationId: string | undefined;
  repository: NewSessionRepository | null;
}): SessionEnvironment {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const wire = toEnvironmentRepositoryInput(repository);
  const choiceKey = repository === null ? null : environmentChoiceKey(organizationId, repository);
  const scope = organizationId ? { organizationId } : {};
  const list = useQuery(
    trpc.cloudEnvironments.list.queryOptions(
      { repository: wire ?? NO_REPOSITORY, ...scope },
      { enabled: wire !== null }
    )
  );
  const { stored, saveEnvironmentChoice } = usePersistedEnvironmentChoice();
  // A pick the person just made, before (or instead of) the write that records
  // it: the stored map only moves when its write lands, and a failed write drops
  // the pending value, which would leave the picker on "choose" and Start
  // disabled with no way out. The web keeps the same pick in React state and
  // treats storage as best effort.
  const [madeChoice, setMadeChoice] = useState<{ key: string; environmentId: string } | null>(null);
  const chosenId = chosenEnvironmentId(madeChoice, stored, choiceKey);
  const matches = list.data;
  const selection: EnvironmentSelection =
    wire === null ? { status: 'idle' } : selectEnvironment(matches, chosenId, list.isLoading);

  // One build status per match, so the picker shows every environment's state
  // instead of only the selected one. Only a running build polls.
  const buildStatus = useQueries({
    queries: (matches ?? []).map(environment =>
      trpc.cloudEnvironments.buildStatus.queryOptions(
        { environmentId: environment.id, ...scope },
        {
          staleTime: 0,
          refetchInterval: query =>
            isBuildActive(query.state.data?.activeBuild) ? BUILD_POLL_MS : false,
        }
      )
    ),
  });

  const buildStatusIndex = useMemo(() => {
    const byId = new Map<string, EnvironmentBuildStatusRow | undefined>();
    const failed = new Set<string>();
    for (const [index, environment] of (matches ?? []).entries()) {
      byId.set(environment.id, buildStatus[index]?.data);
      if (buildStatus[index]?.isError) {
        failed.add(environment.id);
      }
    }
    return { byId, failed };
  }, [matches, buildStatus]);

  return {
    matches,
    isError: list.isError,
    retryEnvironmentList: () => {
      void list.refetch();
    },
    selection,
    environment: selectedEnvironment(selection),
    buildStatusFor: (environmentId: string) => buildStatusIndex.byId.get(environmentId),
    buildStatusFailedFor: (environmentId: string) => buildStatusIndex.failed.has(environmentId),
    retryBuildStatus: () => {
      void queryClient.refetchQueries({
        queryKey: trpc.cloudEnvironments.buildStatus.queryKey(),
      });
    },
    chooseEnvironment: (environmentId: string) => {
      if (choiceKey === null) {
        return;
      }
      setMadeChoice({ key: choiceKey, environmentId });
      saveEnvironmentChoice(choiceKey, environmentId);
    },
  };
}

'use client';

import { useCallback, useState } from 'react';
import {
  useRepositoryEnvironments,
  type EnvironmentRepository,
} from '@/hooks/useCloudAgentEnvironments';
import { repositoryKey } from '@/components/cloud-agent-next/environment-repositories';
import {
  branchKey,
  buildRequestedEnvironment,
  selectEnvironment,
  selectedEnvironment,
  type AdditionalBranches,
} from '@/components/cloud-agent-next/environment-selection';

type Choice = { repositoryKey: string; environmentId: string | null; branches: AdditionalBranches };

/**
 * The environment of a new session in the selected repository: the matches, the
 * user's choice among several, and the branch of each additional repository.
 * The choice starts over when the repository changes.
 */
export function useSessionEnvironment({
  organizationId,
  repository,
}: {
  organizationId?: string;
  repository: EnvironmentRepository | undefined;
}) {
  const { matches, isLoading } = useRepositoryEnvironments({ organizationId, repository });
  const currentKey = repository ? repositoryKey(repository) : '';
  const [stored, setStored] = useState<Choice>({
    repositoryKey: '',
    environmentId: null,
    branches: {},
  });
  const choice: Choice =
    stored.repositoryKey === currentKey
      ? stored
      : { repositoryKey: currentKey, environmentId: null, branches: {} };

  const selection = selectEnvironment(matches, choice.environmentId, isLoading);

  const chooseEnvironment = useCallback(
    (environmentId: string) =>
      setStored({ repositoryKey: currentKey, environmentId, branches: {} }),
    [currentKey]
  );
  const setBranch = useCallback(
    (member: { repoFullName: string }, branch: string) =>
      setStored(previous => {
        const base: Choice =
          previous.repositoryKey === currentKey
            ? previous
            : { repositoryKey: currentKey, environmentId: null, branches: {} };
        return { ...base, branches: { ...base.branches, [branchKey(member)]: branch } };
      }),
    [currentKey]
  );

  return {
    /** Every environment that contains the repository; undefined while unknown. */
    matches,
    selection,
    /** The environment: null when there is none, undefined while unknown or not yet chosen. */
    environment: selectedEnvironment(selection),
    branches: choice.branches,
    chooseEnvironment,
    setBranch,
    requestedEnvironment: repository
      ? buildRequestedEnvironment(selection, repository, choice.branches)
      : undefined,
  };
}

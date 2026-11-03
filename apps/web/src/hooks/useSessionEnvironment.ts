'use client';

import { useCallback, useState } from 'react';
import {
  useRepositoryEnvironments,
  type EnvironmentRepository,
} from '@/hooks/useCloudAgentEnvironments';
import { repositoryKey } from '@/components/cloud-agent-next/environment-repositories';
import {
  buildRequestedEnvironment,
  selectEnvironment,
  selectedEnvironment,
} from '@/components/cloud-agent-next/environment-selection';

type Choice = { repositoryKey: string; environmentId: string | null };

/**
 * The environment of a new session in the selected repository: the matches, the
 * user's choice among several.
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
  });
  const choice: Choice =
    stored.repositoryKey === currentKey
      ? stored
      : { repositoryKey: currentKey, environmentId: null };

  const selection = selectEnvironment(matches, choice.environmentId, isLoading);

  const chooseEnvironment = useCallback(
    (environmentId: string) => setStored({ repositoryKey: currentKey, environmentId }),
    [currentKey]
  );

  return {
    /** Every environment that contains the repository; undefined while unknown. */
    matches,
    selection,
    /** The environment: null when there is none, undefined while unknown or not yet chosen. */
    environment: selectedEnvironment(selection),
    chooseEnvironment,
    requestedEnvironment: repository
      ? buildRequestedEnvironment(selection, repository, {})
      : undefined,
  };
}

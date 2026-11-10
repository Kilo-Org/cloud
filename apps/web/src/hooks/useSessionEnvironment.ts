'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  useRepositoryEnvironments,
  type EnvironmentRepository,
} from '@/hooks/useCloudAgentEnvironments';
import {
  repositoryKey,
  repositoryName,
} from '@/components/cloud-agent-next/environment-repositories';
import { useTRPC } from '@/lib/trpc/utils';
import {
  buildRequestedEnvironment,
  NO_ENVIRONMENT,
  selectEnvironment,
  selectedEnvironment,
} from '@/components/cloud-agent-next/environment-selection';
import { safeLocalStorage } from '@/lib/localStorage';

type Choice = { key: string; id: string | null };

export function useSessionEnvironment({
  organizationId,
  repository,
}: {
  organizationId?: string;
  repository: EnvironmentRepository | undefined;
}) {
  const { matches, isLoading } = useRepositoryEnvironments({ organizationId, repository });
  const trpc = useTRPC();
  const supportsRepositoryDefault = !!repository && repository.platform !== 'bitbucket';
  const defaultEnvironment = useQuery(
    trpc.cloudAgentSettings.getRepositoryEnvironmentDefault.queryOptions(
      {
        organizationId,
        repoFullName: repository ? repositoryName(repository) : '',
        platform: repository?.platform === 'gitlab' ? 'gitlab' : 'github',
      },
      { enabled: supportsRepositoryDefault, staleTime: 30_000 }
    )
  );
  const key = repository
    ? `cloud-agent:environment:${organizationId ?? 'personal'}:${repositoryKey(repository)}`
    : '';
  const [stored, setStored] = useState<Choice>({ key: '', id: null });

  useEffect(() => {
    setStored({ key, id: key ? safeLocalStorage.getItem(key) : null });
  }, [key]);

  const storedChoice = stored.key === key ? stored.id : null;
  const choice =
    storedChoice === NO_ENVIRONMENT || matches?.some(environment => environment.id === storedChoice)
      ? storedChoice
      : null;
  const selection = selectEnvironment(
    supportsRepositoryDefault && defaultEnvironment.isError && choice === null
      ? undefined
      : matches,
    choice,
    isLoading || (supportsRepositoryDefault && defaultEnvironment.isLoading),
    supportsRepositoryDefault ? defaultEnvironment.data : undefined
  );

  const chooseEnvironment = useCallback(
    (id: string | null) => {
      setStored({ key, id });
      if (key) {
        if (id === null) safeLocalStorage.removeItem(key);
        else safeLocalStorage.setItem(key, id);
      }
    },
    [key]
  );

  return {
    /** Every environment that contains the repository; undefined while unknown. */
    matches,
    selection,
    choice,
    /** The environment: null when there is none, undefined while unknown or not yet chosen. */
    environment: selectedEnvironment(selection),
    chooseEnvironment,
    requestedEnvironment: repository
      ? buildRequestedEnvironment(selection, repository, {})
      : undefined,
  };
}

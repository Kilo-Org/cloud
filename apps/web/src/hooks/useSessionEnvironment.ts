'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { safeLocalStorage } from '@/lib/localStorage';

type Choice = { key: string; id: string | null };

/**
 * The environment of a new session in the selected repository: the matches, the
 * user's choice among several.
 * Remember the last choice for each repository and personal/organization scope.
 */
export function useSessionEnvironment({
  organizationId,
  repository,
}: {
  organizationId?: string;
  repository: EnvironmentRepository | undefined;
}) {
  const { matches, isLoading } = useRepositoryEnvironments({ organizationId, repository });
  const key = repository
    ? `cloud-agent:environment:${organizationId ?? 'personal'}:${repositoryKey(repository)}`
    : '';
  const [stored, setStored] = useState<Choice>({ key: '', id: null });

  useEffect(() => {
    setStored({ key, id: key ? safeLocalStorage.getItem(key) : null });
  }, [key]);

  const selection = selectEnvironment(matches, stored.key === key ? stored.id : null, isLoading);

  const chooseEnvironment = useCallback(
    (id: string) => {
      setStored({ key, id });
      if (key) safeLocalStorage.setItem(key, id);
    },
    [key]
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

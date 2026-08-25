import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { toast } from 'sonner-native';

import {
  describePrefillFallback,
  type NewSessionPrefill,
  readNewSessionPrefill,
  resolvePrefillModel,
  resolvePrefillRepo,
} from '@/components/agents/new-session-prefill';

/**
 * Read prefill values from the current route's search params. Memoized on
 * the four raw param values.
 */
export function useNewSessionPrefill(): NewSessionPrefill {
  const raw = useLocalSearchParams<{
    prefillRepo?: string | string[];
    prefillMode?: string | string[];
    prefillModel?: string | string[];
    prefillVariant?: string | string[];
  }>();

  const { prefillRepo, prefillMode, prefillModel, prefillVariant } = raw;

  const prefill = useMemo(
    () => readNewSessionPrefill({ prefillRepo, prefillMode, prefillModel, prefillVariant }),
    [prefillRepo, prefillMode, prefillModel, prefillVariant]
  );

  return prefill;
}

export type UseNewSessionPrefillTargetsInput = {
  repositories: { key: string; fullName: string }[];
  // !isLoadingRepos && !isReposError && repositories.length > 0
  reposSettled: boolean;
  models: { id: string; variants: string[] }[];
  // !isLoadingModels && !isModelsError && models.length > 0
  modelsSettled: boolean;
};

/**
 * Owns the `selectedRepo` state and applies the repo prefill exactly once
 * when the repository list settles. Also fires the fallback info toast at
 * most once per mount.
 *
 * The repo prefill apply mirrors the existing `hasAppliedAutoSelection`
 * pattern in `agent-chat/new.tsx` — a same-component render-phase update
 * guarded by a ref.
 */
export function useNewSessionPrefillTargets(input: UseNewSessionPrefillTargetsInput) {
  const { repositories, reposSettled, models, modelsSettled } = input;
  const prefill = useNewSessionPrefill();
  const [selectedRepo, setSelectedRepo] = useState('');
  const hasAppliedRepo = useRef(false);
  const hasFiredToast = useRef(false);

  if (!hasAppliedRepo.current && reposSettled && !selectedRepo) {
    hasAppliedRepo.current = true;
    const resolved = resolvePrefillRepo(repositories, prefill);
    if (resolved) {
      setSelectedRepo(
        repositories.find(repository => repository.fullName === resolved)?.key ?? resolved
      );
    }
  }

  useEffect(() => {
    if (hasFiredToast.current) {
      return;
    }

    const note = describePrefillFallback({
      prefill,
      repos: {
        settled: reposSettled,
        matched: resolvePrefillRepo(repositories, prefill) !== null,
      },
      models: {
        settled: modelsSettled,
        matched: resolvePrefillModel(models, prefill) !== null,
      },
    });

    if (note) {
      hasFiredToast.current = true;
      toast.info(note);
    }
  }, [prefill, reposSettled, modelsSettled, repositories, models]);

  return { selectedRepo, setSelectedRepo };
}

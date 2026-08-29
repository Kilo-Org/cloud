import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { toast } from 'sonner-native';
import { type ResolvedNewSessionRepository } from '@/components/agents/new-session-repository-state';

import {
  describePrefillFallback,
  type NewSessionPrefill,
  readNewSessionPrefill,
  resolvePrefillModel,
  resolvePrefillRepoSelection,
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
  repositories: ResolvedNewSessionRepository[];
  /** Request settlement does not prove complete authorized discovery. */
  reposSettled: boolean;
  models: { id: string; variants: string[] }[];
  // !isLoadingModels && !isModelsError && models.length > 0
  modelsSettled: boolean;
};

/**
 * Owns the `selectedRepo` state and applies an exact authorized prefill once.
 * Partial browsing can establish an exact match, but never a legacy match or absence.
 * Fires the fallback info toast at most once per mount.
 *
 * The repo prefill apply mirrors the existing `hasAppliedAutoSelection`
 * pattern in `agent-chat/new.tsx` — a same-component render-phase update
 * guarded by a ref.
 */
export function useNewSessionPrefillTargets(input: UseNewSessionPrefillTargetsInput) {
  const { repositories, models, modelsSettled } = input;
  const prefill = useNewSessionPrefill();
  const [selectedRepo, setSelectedRepo] = useState('');
  const hasAppliedRepo = useRef(false);
  const hasFiredToast = useRef(false);
  const resolvedRepo = resolvePrefillRepoSelection(repositories, prefill);

  if (!hasAppliedRepo.current && resolvedRepo && !selectedRepo) {
    hasAppliedRepo.current = true;
    setSelectedRepo(resolvedRepo);
  }

  useEffect(() => {
    if (hasFiredToast.current) {
      return;
    }

    const note = describePrefillFallback({
      prefill,
      repos: {
        // Browsing cannot prove absence. Do not announce that an unresolved prefill is unavailable.
        settled: !prefill.repo || resolvedRepo !== null,
        matched: resolvedRepo !== null,
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
  }, [prefill, resolvedRepo, modelsSettled, models]);

  return { selectedRepo, setSelectedRepo };
}

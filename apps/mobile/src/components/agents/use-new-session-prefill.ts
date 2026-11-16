import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { toast } from 'sonner-native';

import {
  describePrefillFallback,
  isRepoSeedPending,
  type NewSessionPrefill,
  readNewSessionPrefill,
  resolvePrefillModel,
  resolvePrefillRepoSelection,
  resolveStoredRepoSelection,
  shouldAbandonRepoSeed,
} from '@/components/agents/new-session-prefill';

/**
 * Read prefill values from the current route's search params. Memoized on
 * the raw param values.
 */
export function useNewSessionPrefill(): NewSessionPrefill {
  const raw = useLocalSearchParams<{
    prefillRepo?: string | string[];
    prefillMode?: string | string[];
    prefillModel?: string | string[];
    prefillVariant?: string | string[];
    prefillPrompt?: string | string[];
    prefillTodoTitle?: string | string[];
    todoId?: string | string[];
  }>();

  const {
    prefillRepo,
    prefillMode,
    prefillModel,
    prefillVariant,
    prefillPrompt,
    prefillTodoTitle,
    todoId,
  } = raw;

  const prefill = useMemo(
    () =>
      readNewSessionPrefill({
        prefillRepo,
        prefillMode,
        prefillModel,
        prefillVariant,
        prefillPrompt,
        prefillTodoTitle,
        todoId,
      }),
    [
      prefillRepo,
      prefillMode,
      prefillModel,
      prefillVariant,
      prefillPrompt,
      prefillTodoTitle,
      todoId,
    ]
  );

  return prefill;
}

export type UseNewSessionPrefillTargetsInput = {
  repositories: { platform: string; fullName: string }[];
  // !isLoadingRepos && !isReposError && repositories.length > 0
  reposSettled: boolean;
  /**
   * The repository region's bounded signal: true once each provider query
   * finished loading, or once the settle bound expired while one was still
   * loading. A paused or disabled query counts as resolved.
   *
   * Bounded on purpose. A list that never answers must not withhold the form's
   * rows, here or anywhere else, so a prefill still unanswered at the bound is
   * given up (`shouldAbandonRepoSeed`) instead of deferred — a late answer then
   * cannot mount a repository the region was declared final without.
   *
   * This is not `reposSettled`, which also requires no error and at least one
   * row: a prefill can only seed in the render `reposSettled` turns true, so a
   * repo the lists cannot satisfy must let the repository region settle
   * instead of holding it — and the form's rows below it — forever.
   */
  providerQueriesResolved: boolean;
  models: { id: string; variants: string[] }[];
  // !isLoadingModels && !isModelsError && models.length > 0
  modelsSettled: boolean;
  /**
   * The durable repository draft for this account and organization: the
   * `platform:fullName` key the form last held, or null before it loads and
   * when none is stored.
   */
  storedRepo?: string | null;
};

/**
 * Owns the `selectedRepo` state and applies the repo prefill exactly once
 * when the repository list settles. Also fires the fallback info toast at
 * most once per mount.
 *
 * The repo prefill apply mirrors the existing `hasAppliedAutoSelection`
 * pattern in `agent-chat/new.tsx` — a same-component render-phase update
 * guarded by a ref. The durable draft seeds the same state the same way, so a
 * form reopened after a restart shows the repository it had before the user
 * sees an empty row; a route prefill outranks it (see
 * `resolveStoredRepoSelection`).
 */
export function useNewSessionPrefillTargets(input: UseNewSessionPrefillTargetsInput) {
  const {
    repositories,
    reposSettled,
    providerQueriesResolved,
    models,
    modelsSettled,
    storedRepo = null,
  } = input;
  const prefill = useNewSessionPrefill();
  const [selectedRepo, setSelectedRepo] = useState('');
  const hasAppliedRepo = useRef(false);
  const hasSeededStoredRepo = useRef(false);
  const hasFiredToast = useRef(false);

  const storedSeed = resolveStoredRepoSelection({ prefill, selectedRepo, storedRepo });
  if (!hasSeededStoredRepo.current && storedSeed) {
    hasSeededStoredRepo.current = true;
    setSelectedRepo(storedSeed);
  }

  // The bound can settle the region before a prefill lands. Give the request up
  // then, so a list that answers later cannot mount a repository the form
  // already painted without. `reposSettled` wins in the same render, because
  // that is the only render in which the seed can run.
  if (
    shouldAbandonRepoSeed({
      prefillRepo: prefill.repo,
      applied: hasAppliedRepo.current,
      selectedRepo,
      reposSettled,
      providerQueriesResolved,
    })
  ) {
    hasAppliedRepo.current = true;
  }

  if (!hasAppliedRepo.current && reposSettled && !selectedRepo) {
    hasAppliedRepo.current = true;
    const resolved = resolvePrefillRepoSelection(repositories, prefill);
    if (resolved) {
      setSelectedRepo(resolved);
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
        matched: resolvePrefillRepoSelection(repositories, prefill) !== null,
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

  return {
    selectedRepo,
    setSelectedRepo,
    /** Whether the route prefill can still replace the selection. */
    repoSeedPending: isRepoSeedPending({
      prefillRepo: prefill.repo,
      applied: hasAppliedRepo.current,
      selectedRepo,
      providerQueriesResolved,
    }),
  };
}

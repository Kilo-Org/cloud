import { useCallback, useRef } from 'react';

import { pickAutoSelectedModel } from '@/lib/hooks/auto-select-model';
import { type ModelOption, useOrgDefaultModel } from '@/lib/hooks/use-available-models';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';

/**
 * The new-session auto-selection phase. One union, because the form commits the
 * model once per account scope: a failed organization-default read is a state
 * that says nothing may be committed, not a flag beside a selection.
 */
type AutoSelectModelState =
  | { kind: 'waiting' }
  | { kind: 'selected'; model: string; variant: string }
  | { kind: 'org-default-failed'; onRetry: () => void; isRetrying: boolean };

export function useAutoSelectModel(
  models: ModelOption[],
  organizationId: string | undefined
): AutoSelectModelState {
  const { lastSelected, isLoading } = useModelPreferences(organizationId);
  const orgDefault = useOrgDefaultModel(organizationId);
  const { stored, hasLoaded } = usePersistedAgentModel();
  // `refetch` answers a result rather than rejecting, and this callback is
  // published to the model row, so the row's retry only starts the attempt.
  const { refetch: refetchOrgDefault } = orgDefault;
  const retryOrgDefault = useCallback(() => {
    void refetchOrgDefault();
  }, [refetchOrgDefault]);
  // The committed pair only: which input chose it stops mattering once the form
  // owns the selection. It carries the account scope it was resolved for, so
  // the pair always belongs to the catalog it was chosen from.
  const scope = organizationId ?? null;
  const chosenRef = useRef<{ scope: string | null; model: string; variant: string } | null>(null);

  const committed = chosenRef.current;
  // An autoselection belongs to the account scope that resolved it, and that
  // scope is the account the create reads, so another scope's pair is dropped.
  if (committed === null || committed.scope !== scope) {
    chosenRef.current = null;
  } else {
    return { kind: 'selected', model: committed.model, variant: committed.variant };
  }
  // Wait for the server preference and the stored preference too, or the shared
  // value loses the race against the local cache on cold start and is never
  // applied.
  if (isLoading || !hasLoaded || models.length === 0) {
    return { kind: 'waiting' };
  }
  const picked = pickAutoSelectedModel({
    models,
    lastSelected,
    stored,
    organizationId,
    orgDefaultModel: orgDefault.defaultModel,
    isDev: __DEV__,
  });
  // A failed organization-default read leaves `defaultModel` undefined, so this
  // same pick already answers "does anything else decide the model?" — a
  // catalogue-first fallback means the organization default was the only
  // remaining input, and committing the first row would hide its failure for
  // the whole mount. The failure is decided before the pending wait: v5 reports
  // a no-data retry as `pending`, and the row has to stay up, with its own busy
  // state, while that retry runs.
  if (orgDefault.isError && (!picked || picked.source === 'catalog-first')) {
    return {
      kind: 'org-default-failed',
      onRetry: retryOrgDefault,
      isRetrying: orgDefault.isFetching,
    };
  }
  if (orgDefault.isPending || !picked) {
    return { kind: 'waiting' };
  }
  chosenRef.current = { scope, model: picked.model, variant: picked.variant };
  return { kind: 'selected', model: picked.model, variant: picked.variant };
}

import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { ModelPreferencesErrorKind } from '@/src/shared/model-preferences-client';

export type ModelPreferencesStatus = 'loading' | 'ready' | 'retryable' | 'terminal';

export interface ModelPreferencesCache {
  readonly favorites: readonly string[];
}

export type TerminalLatchEvent =
  | { readonly type: 'key-changed' }
  | { readonly type: 'mutation-error'; readonly classification: ModelPreferencesErrorKind }
  | { readonly type: 'query-error'; readonly classification: ModelPreferencesErrorKind }
  | { readonly type: 'query-success' };

export const emptyFavoriteIds: ReadonlySet<string> = new Set();

export const applyFavoriteToggle = (favorites: readonly string[], modelId: string): string[] =>
  favorites.includes(modelId) ? favorites.filter(id => id !== modelId) : [...favorites, modelId];

export const reduceTerminalLatch = (latched: boolean, event: TerminalLatchEvent): boolean => {
  switch (event.type) {
    case 'key-changed':
    case 'query-success': {
      return false;
    }
    case 'mutation-error':
    case 'query-error': {
      return event.classification === 'terminal' ? true : latched;
    }
  }
};

export const reduceToggleError = (_current: boolean, event: 'failure' | 'success'): boolean =>
  event === 'failure';

export const deriveModelPreferencesStatus = ({
  isError,
  isPending,
  queryErrorClassification,
  terminalLatched,
}: {
  readonly isError: boolean;
  readonly isPending: boolean;
  readonly queryErrorClassification: ModelPreferencesErrorKind | null;
  readonly terminalLatched: boolean;
}): ModelPreferencesStatus => {
  if (terminalLatched) {
    return 'terminal';
  }

  if (isPending) {
    return 'loading';
  }

  if (isError) {
    return queryErrorClassification === 'terminal' ? 'terminal' : 'retryable';
  }

  return 'ready';
};

const awaitSettled = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // Sequencing only — callers observe their own run outcome.
  }
};

export const createSerialAsyncChain = (): {
  readonly enqueue: <TValue>(work: () => Promise<TValue>) => Promise<TValue>;
} => {
  let chain: Promise<unknown> | undefined = undefined;

  return {
    enqueue: <TValue>(work: () => Promise<TValue>): Promise<TValue> => {
      const previous = chain;
      const run = (async (): Promise<TValue> => {
        if (previous !== undefined) {
          await awaitSettled(previous);
        }

        return work();
      })();
      chain = awaitSettled(run);
      return run;
    },
  };
};

/** True when a toggle completion may write latch / toggle-error UI state. */
export const isFavoriteToggleCompletionCurrent = (
  enqueuedKeyFingerprint: string,
  activeKeyFingerprint: string
): boolean => enqueuedKeyFingerprint === activeKeyFingerprint;

export interface FavoriteToggleUiState {
  readonly terminalLatched: boolean;
  readonly toggleError: boolean;
}

export type FavoriteToggleCompletionOutcome =
  | { readonly ok: true }
  | {
      readonly classification: ModelPreferencesErrorKind;
      readonly ok: false;
    };

/**
 * Apply latch / toggle-error updates only when the enqueued key is still active.
 * Optimistic cache work is separate and always targets the enqueued query key.
 */
export const applyFavoriteToggleCompletionUi = ({
  activeKeyFingerprint,
  enqueuedKeyFingerprint,
  outcome,
  ui,
}: {
  readonly activeKeyFingerprint: string;
  readonly enqueuedKeyFingerprint: string;
  readonly outcome: FavoriteToggleCompletionOutcome;
  readonly ui: FavoriteToggleUiState;
}): FavoriteToggleUiState & { readonly applied: boolean } => {
  if (!isFavoriteToggleCompletionCurrent(enqueuedKeyFingerprint, activeKeyFingerprint)) {
    return { ...ui, applied: false };
  }

  if (outcome.ok) {
    return {
      applied: true,
      terminalLatched: ui.terminalLatched,
      toggleError: reduceToggleError(ui.toggleError, 'success'),
    };
  }

  const terminalLatched = reduceTerminalLatch(ui.terminalLatched, {
    classification: outcome.classification,
    type: 'mutation-error',
  });
  const toggleError =
    outcome.classification === 'retryable'
      ? reduceToggleError(ui.toggleError, 'failure')
      : ui.toggleError;

  return { applied: true, terminalLatched, toggleError };
};

export const runOptimisticFavoriteToggle = async ({
  modelId,
  mutate,
  queryClient,
  queryKey,
}: {
  readonly modelId: string;
  readonly mutate: () => Promise<void>;
  readonly queryClient: Pick<
    QueryClient,
    'cancelQueries' | 'getQueryData' | 'invalidateQueries' | 'setQueryData'
  >;
  readonly queryKey: QueryKey;
}): Promise<{ readonly ok: true } | { readonly error: unknown; readonly ok: false }> => {
  await queryClient.cancelQueries({ queryKey });
  const previous = queryClient.getQueryData<ModelPreferencesCache>(queryKey);
  const snapshot = previous?.favorites ?? [];
  queryClient.setQueryData<ModelPreferencesCache>(queryKey, {
    favorites: applyFavoriteToggle(snapshot, modelId),
  });

  try {
    await mutate();
    return { ok: true };
  } catch (error) {
    queryClient.setQueryData<ModelPreferencesCache>(
      queryKey,
      previous ?? { favorites: [...snapshot] }
    );
    return { error, ok: false };
  } finally {
    /* Reconcile outside the serial chain (app parity): awaiting the refetch
       would delay the next queued toggle by the refetch's retry/backoff. */
    void queryClient.invalidateQueries({ queryKey });
  }
};

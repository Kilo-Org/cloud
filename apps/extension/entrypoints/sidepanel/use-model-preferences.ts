import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getKiloApiBaseUrl } from '@/src/shared/auth';
import type { StoredAuth } from '@/src/shared/auth';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';
import {
  addModelFavorite,
  classifyModelPreferencesError,
  fetchModelPreferences,
  removeModelFavorite,
} from '@/src/shared/model-preferences-client';
import { getModelPreferencesQueryKey } from '@/src/shared/side-panel-query-options';
import {
  applyFavoriteToggleCompletionUi,
  createSerialAsyncChain,
  deriveModelPreferencesStatus,
  emptyFavoriteIds,
  reduceTerminalLatch,
  runOptimisticFavoriteToggle,
} from './model-preferences-state';
import type { ModelPreferencesStatus } from './model-preferences-state';

const apiBaseUrl = getKiloApiBaseUrl();
const fetchFromWindow = (input: string, init?: RequestInit): Promise<Response> =>
  fetch(input, init);

const queryKeyFingerprint = (queryKey: readonly string[]): string => queryKey.join('\0');

export interface UseModelPreferencesResult {
  readonly favorites: ReadonlySet<string>;
  readonly refetch: () => Promise<unknown>;
  readonly status: ModelPreferencesStatus;
  readonly toggleError: boolean;
  readonly toggleFavorite: (model: KiloGatewayModelOption) => void;
}

export const useModelPreferences = ({
  auth,
  organizationId,
}: {
  readonly auth: StoredAuth;
  readonly organizationId: string | undefined;
}): UseModelPreferencesResult => {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => getModelPreferencesQueryKey({ organizationId, token: auth.token }),
    [auth.token, organizationId]
  );
  const keyFingerprint = queryKeyFingerprint(queryKey);
  const previousKeyRef = useRef(keyFingerprint);
  const [terminalLatched, setTerminalLatched] = useState(false);
  const [toggleError, setToggleError] = useState(false);
  const terminalLatchedRef = useRef(terminalLatched);
  const toggleErrorRef = useRef(toggleError);
  /* One serial chain for the hook lifetime (favorites are user-global). */
  const chainRef = useRef(createSerialAsyncChain());

  terminalLatchedRef.current = terminalLatched;
  toggleErrorRef.current = toggleError;

  if (previousKeyRef.current !== keyFingerprint) {
    previousKeyRef.current = keyFingerprint;
    setTerminalLatched(latched => reduceTerminalLatch(latched, { type: 'key-changed' }));
    setToggleError(false);
  }

  const query = useQuery({
    queryFn: ({ signal }) =>
      fetchModelPreferences({
        apiBaseUrl,
        fetch: fetchFromWindow,
        organizationId,
        signal,
        token: auth.token,
      }),
    queryKey,
  });

  useEffect(() => {
    if (query.isSuccess) {
      setTerminalLatched(latched => reduceTerminalLatch(latched, { type: 'query-success' }));
    }
  }, [query.dataUpdatedAt, query.isSuccess]);

  useEffect(() => {
    if (!query.isError) {
      return;
    }

    const classification = classifyModelPreferencesError(query.error);
    setTerminalLatched(latched =>
      reduceTerminalLatch(latched, { classification, type: 'query-error' })
    );
  }, [query.error, query.isError]);

  const status = deriveModelPreferencesStatus({
    isError: query.isError,
    isPending: query.isPending,
    queryErrorClassification: query.isError ? classifyModelPreferencesError(query.error) : null,
    terminalLatched,
  });

  const favorites = useMemo((): ReadonlySet<string> => {
    const list = query.data?.favorites;
    if (list === undefined) {
      return emptyFavoriteIds;
    }

    return new Set(list);
  }, [query.data?.favorites]);

  const toggleFavorite = useCallback(
    (model: KiloGatewayModelOption): void => {
      if (status === 'terminal') {
        return;
      }

      /* Capture at enqueue: stale-guard UI; cache ops keep this query key. */
      const enqueuedFingerprint = keyFingerprint;
      const enqueuedOrganizationId = organizationId;
      const enqueuedQueryKey = [...queryKey];
      const enqueuedToken = auth.token;

      void chainRef.current.enqueue(async () => {
        const cached = queryClient.getQueryData<{ favorites: readonly string[] }>(enqueuedQueryKey);
        const isFavorite = (cached?.favorites ?? []).includes(model.id);
        const result = await runOptimisticFavoriteToggle({
          modelId: model.id,
          mutate: () =>
            isFavorite
              ? removeModelFavorite({
                  apiBaseUrl,
                  fetch: fetchFromWindow,
                  model: model.id,
                  organizationId: enqueuedOrganizationId,
                  token: enqueuedToken,
                })
              : addModelFavorite({
                  apiBaseUrl,
                  fetch: fetchFromWindow,
                  model: model.id,
                  organizationId: enqueuedOrganizationId,
                  token: enqueuedToken,
                }),
          queryClient,
          queryKey: enqueuedQueryKey,
        });

        const next = result.ok
          ? applyFavoriteToggleCompletionUi({
              activeKeyFingerprint: previousKeyRef.current,
              enqueuedKeyFingerprint: enqueuedFingerprint,
              outcome: { ok: true },
              ui: {
                terminalLatched: terminalLatchedRef.current,
                toggleError: toggleErrorRef.current,
              },
            })
          : applyFavoriteToggleCompletionUi({
              activeKeyFingerprint: previousKeyRef.current,
              enqueuedKeyFingerprint: enqueuedFingerprint,
              outcome: {
                classification: classifyModelPreferencesError(result.error),
                ok: false,
              },
              ui: {
                terminalLatched: terminalLatchedRef.current,
                toggleError: toggleErrorRef.current,
              },
            });

        if (!next.applied) {
          return;
        }

        setTerminalLatched(next.terminalLatched);
        setToggleError(next.toggleError);
      });
    },
    [auth.token, keyFingerprint, organizationId, queryClient, queryKey, status]
  );

  return {
    favorites,
    refetch: query.refetch,
    status,
    toggleError,
    toggleFavorite,
  };
};

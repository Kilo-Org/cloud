import { useQuery } from '@tanstack/react-query';
import {
  type InstanceModelCatalogResult,
  listInstanceModels,
  type RemoteModelCatalogV1,
} from '@kilocode/cloud-agent-sdk/instance-model-catalog';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';

/**
 * Fetch the model catalog of one selected CLI instance before a session
 * exists. The catalog is cached per `connectionId` with a short stale time,
 * never globally: a `list_models` result belongs to one instance.
 *
 * Retry design lives here: only the retryable `transport` outcome is turned
 * into a rejection so React Query owns the retry (1 attempt) and the
 * refetch-on-mount. The permanent `unsupported` (old CLI) and `invalid`
 * outcomes resolve and cache; retrying them would be pure waste.
 *
 * React Query keeps the last successful `data` for a key when a later
 * refetch fails, so once an instance has answered, a transient failure keeps
 * serving that catalog instead of dropping to the gateway fallback. The
 * gateway fallback therefore means "this instance has never answered", not
 * "the last read failed".
 */
export function useInstanceModelCatalog(connectionId: string | null): {
  catalog: RemoteModelCatalogV1 | null;
  isLoading: boolean;
} {
  const connection = useUserWebConnection();
  const { data, isPending } = useQuery<InstanceModelCatalogResult>({
    queryKey: ['instance-model-catalog', connectionId],
    queryFn: async () => {
      // `enabled` guarantees a non-null id; the guard narrows the type for
      // the SDK call and keeps the queryFn total for the impossible case.
      if (connectionId === null) {
        return { ok: false, reason: 'transport' as const };
      }
      const result = await listInstanceModels(connection, connectionId);
      if (!result.ok && result.reason === 'transport') {
        // Retryable: let React Query own the retry and the refetch-on-mount.
        throw new Error('instance catalog unavailable');
      }
      return result;
    },
    enabled: connectionId !== null,
    retry: 1,
    staleTime: 30_000,
  });

  // Count models, not providers. The wire schema's per-provider `models`
  // record has no minimum, so a provider with an empty `models` array is
  // schema-valid and must not satisfy the guard; a catalog that projects to
  // zero options belongs on the gateway fallback, not in an empty picker.
  const hasModel =
    data?.ok === true && data.catalog.providers.some(provider => provider.models.length > 0);
  const catalog = hasModel ? data.catalog : null;

  return { catalog, isLoading: connectionId !== null && isPending };
}

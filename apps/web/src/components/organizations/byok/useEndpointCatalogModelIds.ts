import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useDebouncedValue } from '@/components/organizations/guardrails/mcp-and-skills/use-debounced-value';

export type EndpointCatalogModelIds = {
  /** The ids that were looked up; an id typed since then is not in it. */
  checked: ReadonlySet<string>;
  /** The checked ids that a catalog-mode endpoint serves. */
  served: ReadonlySet<string>;
};

/**
 * Which of `modelIds` are Kilo catalog ids that a catalog-mode endpoint serves. Null while
 * disabled or loading.
 */
export function useEndpointCatalogModelIds(
  organizationId: string,
  modelIds: string[],
  enabled: boolean
): EndpointCatalogModelIds | null {
  const trpc = useTRPC();
  const ids = [...new Set(modelIds.map(id => id.trim()).filter(id => id !== ''))].sort();
  const debouncedIds = useDebouncedValue(JSON.stringify(ids), 400);
  const checkedIds = useMemo(() => JSON.parse(debouncedIds) as string[], [debouncedIds]);
  const { data } = useQuery({
    ...trpc.byok.listEndpointCatalogModelIds.queryOptions({ organizationId, modelIds: checkedIds }),
    enabled: enabled && checkedIds.length > 0,
  });
  return useMemo(
    () => (enabled && data ? { checked: new Set(checkedIds), served: new Set(data) } : null),
    [enabled, data, checkedIds]
  );
}

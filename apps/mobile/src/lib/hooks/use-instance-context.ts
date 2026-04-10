import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';

export function useAllKiloClawInstances() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.listAllInstances.queryOptions(undefined, {
      staleTime: 30_000,
      refetchInterval: 30_000,
    })
  );
}

/**
 * Resolves the `organizationId` for a KiloClaw instance by looking up
 * the cached `listAllInstances` data. Returns:
 * - `string` — the org ID (instance belongs to an organization)
 * - `null`   — personal instance (no organization)
 * - `undefined` — data not yet loaded / instance not found
 */
export function useInstanceOrganizationId(sandboxId: string): string | null | undefined {
  const { data: instances } = useAllKiloClawInstances();
  if (!instances) {
    return undefined;
  }
  const match = instances.find(i => i.sandboxId === sandboxId);
  return match ? match.organizationId : undefined;
}

import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';

export type ClawInstance = inferRouterOutputs<RootRouter>['kiloclaw']['listAllInstances'][number];

export type InstanceContextResult =
  | { status: 'loading' }
  | { status: 'error'; refetch: () => void }
  | { status: 'not_found' }
  | { status: 'ready'; instance: ClawInstance; organizationId: string | null; isOrg: boolean };

/**
 * Derives instance context (org vs personal, or a terminal loading/error/
 * not-found state) from the cached `listAllInstances` list. Pulled out as a
 * pure function, with no react-query/react-native imports, so the status
 * derivation can be unit tested without rendering a hook.
 *
 * Cached data always wins over a background refetch error — a stale-but-
 * present match still resolves to `ready`/`not_found`; `error` only fires
 * on an initial-load failure with no cached data yet.
 */
export function deriveInstanceContext(
  sandboxId: string,
  list: { data: ClawInstance[] | undefined; isError: boolean },
  refetch: () => void
): InstanceContextResult {
  if (list.data !== undefined) {
    const instance = list.data.find(i => i.sandboxId === sandboxId);
    if (!instance) {
      return { status: 'not_found' };
    }
    const organizationId = instance.organizationId ?? null;
    return { status: 'ready', instance, organizationId, isOrg: Boolean(organizationId) };
  }
  if (list.isError) {
    return { status: 'error', refetch };
  }
  return { status: 'loading' };
}

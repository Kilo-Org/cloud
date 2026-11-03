import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { type InfiniteData, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { persistQueryClientSave } from '@tanstack/react-query-persist-client';
import { z } from 'zod';

import { canReadBriefingContext } from '@/lib/agent-briefing-state';
import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import {
  createReadCachePersister,
  readCachedUserId,
  shouldPersistReadCacheQuery,
} from '@/lib/persist/read-cache';

type BriefingOutputs = inferRouterOutputs<MobileRouter>['agentBriefing'];
const contextInputSchema = z.object({
  input: z.object({ organizationId: z.string().optional() }).optional(),
});

function pruneBriefingQuery(
  client: QueryClient,
  key: QueryKey,
  organizationIds: readonly string[]
): boolean {
  const input = contextInputSchema.safeParse(key[1]);
  const organizationId = input.success ? input.data.input?.organizationId : undefined;
  if (organizationId && !canReadBriefingContext(organizationId, true, organizationIds)) {
    client.removeQueries({ queryKey: key, exact: true });
    return true;
  }
  const path = key[0];
  if (!Array.isArray(path)) {
    return false;
  }
  const procedure = path.at(-1);
  if (procedure === 'get') {
    const report = client.getQueryData<BriefingOutputs['get']>(key);
    if (report && !canReadBriefingContext(report.context.organizationId, true, organizationIds)) {
      client.removeQueries({ queryKey: key, exact: true });
      return true;
    }
  } else if (procedure === 'list') {
    const data = client.getQueryData<
      BriefingOutputs['list'] | InfiniteData<BriefingOutputs['list']>
    >(key);
    if (!data) {
      return false;
    }
    const filterPage = (page: BriefingOutputs['list']) => {
      const reports = page.reports.filter(report =>
        canReadBriefingContext(report.context.organizationId, true, organizationIds)
      );
      return reports.length === page.reports.length ? page : { ...page, reports };
    };
    if ('pages' in data) {
      const pages = data.pages.map(filterPage);
      if (pages.every((page, index) => page === data.pages[index])) {
        return false;
      }
      client.setQueryData(key, { ...data, pages });
    } else {
      const next = filterPage(data);
      if (next === data) {
        return false;
      }
      client.setQueryData(key, next);
    }
    return true;
  } else if (procedure === 'preferences') {
    const data = client.getQueryData<BriefingOutputs['preferences']>(key);
    if (!data) {
      return false;
    }
    const contexts = data.contexts.filter(item =>
      canReadBriefingContext(item.context.organizationId, true, organizationIds)
    );
    if (contexts.length !== data.contexts.length) {
      client.setQueryData(key, { ...data, contexts });
      return true;
    }
  }
  return false;
}

export async function purgeInaccessibleBriefingCache(
  client: QueryClient,
  { userId, authEpoch }: { userId: string; authEpoch: number },
  organizationIds: readonly string[]
): Promise<boolean> {
  if (!isCurrentAuthEpoch(authEpoch) || isSignOutActive() || readCachedUserId(client) !== userId) {
    return false;
  }
  let changed = false;
  for (const query of client.getQueryCache().findAll({ queryKey: [['agentBriefing']] })) {
    const removed = pruneBriefingQuery(client, query.queryKey, organizationIds);
    changed = removed || changed;
  }
  if (changed) {
    await persistQueryClientSave({
      queryClient: client,
      persister: createReadCachePersister({ queryClient: client, userId, epoch: authEpoch }),
      dehydrateOptions: {
        shouldDehydrateQuery: shouldPersistReadCacheQuery,
        shouldDehydrateMutation: () => false,
      },
    });
  }
  return changed;
}

import type {
  ProviderAdapter,
  ProviderLaunchOptions,
  ProviderStartSource,
} from '../../sandbox-control/provider.js';
import type { RouteRecord } from './routes.js';

const LAUNCH_KEY = 'repository_launch';

/**
 * How the most recent allocation's container started, and whether its wrapper ever
 * connected. It is the one piece of durable memory the "first start only" rule
 * needs: a repository start whose wrapper never connected is a broken snapshot.
 */
export type RepositoryLaunchRecord = {
  allocationId: string;
  startSource: ProviderStartSource;
  confirmed: boolean;
};

export async function readRepositoryLaunch(
  storage: Pick<DurableObjectStorage, 'get'>
): Promise<RepositoryLaunchRecord | undefined> {
  return storage.get<RepositoryLaunchRecord>(LAUNCH_KEY);
}

export async function recordRepositoryLaunch(
  storage: Pick<DurableObjectStorage, 'put'>,
  record: RepositoryLaunchRecord
): Promise<void> {
  await storage.put(LAUNCH_KEY, record);
}

/** The wrapper of `allocationId` connected, so its start source was sound. */
export async function confirmRepositoryLaunch(
  storage: Pick<DurableObjectStorage, 'get' | 'put'>,
  allocationId: string
): Promise<void> {
  const record = await readRepositoryLaunch(storage);
  if (record === undefined || record.allocationId !== allocationId || record.confirmed) return;
  await recordRepositoryLaunch(storage, { ...record, confirmed: true });
}

/**
 * The launch options for a new allocation. The key comes from the routes waiting
 * for it: exactly one key shared by all of them, else no snapshot. When the
 * previous allocation started from a repository snapshot and its wrapper never
 * connected, the snapshot is discarded and this start is from the image, so a
 * broken snapshot costs one attempt and the capture that follows replaces it.
 */
export function repositoryLaunchOptions(
  routes: readonly RouteRecord[],
  previous: RepositoryLaunchRecord | undefined
): ProviderLaunchOptions {
  const keys = new Set(routes.filter(route => route.state === 'preparing').map(r => r.repoKey));
  if (keys.size !== 1) return {};
  const [repoKey] = keys;
  if (repoKey === null || repoKey === undefined) return {};
  const previousStartFailed = previous?.startSource === 'repository' && !previous.confirmed;
  return { repoKey, ...(previousStartFailed ? { discardRepository: true as const } : {}) };
}

/** Whether `session.prepare` should ask the wrapper to save the prepared workspace. */
export function captureRequested(
  route: Pick<RouteRecord, 'repoKey'>,
  provider: Pick<ProviderAdapter, 'captureRepository'>
): boolean {
  return route.repoKey !== null && provider.captureRepository !== undefined;
}

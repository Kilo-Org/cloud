import type {
  ProviderAdapter,
  ProviderLaunchOptions,
  ProviderStartSource,
} from '../../sandbox-control/provider.js';
import type { RouteRecord } from './routes.js';
import type { ControlPlaneWorkspaceFailureSubtype } from '../../shared/control-plane-protocol.js';

const LAUNCH_KEY = 'repository_launch';

export type RepositoryPreparationFailure = {
  sessionId: string;
  attemptId: string;
  subtype?: ControlPlaneWorkspaceFailureSubtype;
};

export type RepositoryLaunchRecord = {
  allocationId: string;
  /** Absent in the placeholder written before `launch` reports the source. */
  startSource?: ProviderStartSource;
  skipRepository?: true;
  confirmed: boolean;
  preparationFailures?: RepositoryPreparationFailure[];
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

/** A pending image fallback must remain snapshot-free if its launch never reports a source. */
export async function beginRepositoryLaunch(
  storage: Pick<DurableObjectStorage, 'put'>,
  allocationId: string,
  skipRepository: boolean
): Promise<void> {
  await recordRepositoryLaunch(storage, {
    allocationId,
    ...(skipRepository ? { skipRepository: true } : {}),
    confirmed: false,
  });
}

/** A connection confirms launch, not workspace preparation. */
export async function confirmRepositoryLaunch(
  storage: Pick<DurableObjectStorage, 'get' | 'put'>,
  allocationId: string
): Promise<void> {
  const record = await readRepositoryLaunch(storage);
  if (record === undefined || record.allocationId !== allocationId || record.confirmed) return;
  await recordRepositoryLaunch(storage, { ...record, confirmed: true });
}

/** Why a launch did or did not ask the provider to start from a repository snapshot. */
export type RepositoryLaunchReason =
  | 'no_preparing_routes'
  | 'no_repo_key'
  | 'multiple_keys'
  | 'repository';

/**
 * A launch's snapshot decision plus what drove it, so one log line can explain a
 * start from the image without re-deriving the rule at the call site.
 */
export type RepositoryLaunchDecision = {
  options: ProviderLaunchOptions;
  reason: RepositoryLaunchReason;
  preparingRouteCount: number;
  /** Distinct keys across preparing routes; `> 1` is why a snapshot was not used. */
  distinctKeyCount: number;
  /** The previous repository launch or preparation failed. */
  skipped: boolean;
};

/**
 * The launch options for a new allocation. The key comes from the routes waiting
 * for it: exactly one key shared by all of them, else no snapshot. When the
 * previous repository allocation never connected or failed preparation, this
 * start uses the image without deleting the snapshot.
 */
export function repositoryLaunchOptions(
  routes: readonly RouteRecord[],
  previous: RepositoryLaunchRecord | undefined
): RepositoryLaunchDecision {
  const preparing = routes.filter(route => route.state === 'preparing');
  const keys = new Set(preparing.map(route => route.repoKey));
  const preparingRouteCount = preparing.length;
  const distinctKeyCount = keys.size;
  if (preparingRouteCount === 0) {
    return {
      options: {},
      reason: 'no_preparing_routes',
      preparingRouteCount,
      distinctKeyCount,
      skipped: false,
    };
  }
  if (distinctKeyCount !== 1) {
    return {
      options: {},
      reason: 'multiple_keys',
      preparingRouteCount,
      distinctKeyCount,
      skipped: false,
    };
  }
  const [repoKey] = keys;
  if (repoKey === null || repoKey === undefined) {
    return {
      options: {},
      reason: 'no_repo_key',
      preparingRouteCount,
      distinctKeyCount,
      skipped: false,
    };
  }
  const previousStartFailed =
    previous?.skipRepository === true ||
    (previous?.startSource === 'repository' && !previous.confirmed) ||
    (previous?.startSource !== 'image' && (previous?.preparationFailures?.length ?? 0) > 0);
  return {
    options: { repoKey, ...(previousStartFailed ? { skipRepository: true as const } : {}) },
    reason: 'repository',
    preparingRouteCount,
    distinctKeyCount,
    skipped: previousStartFailed,
  };
}

/** Whether `session.prepare` should ask the wrapper to save the prepared workspace. */
export function captureRequested(
  route: Pick<RouteRecord, 'repoKey'>,
  provider: Pick<ProviderAdapter, 'captureRepository'>
): boolean {
  return route.repoKey !== null && provider.captureRepository !== undefined;
}

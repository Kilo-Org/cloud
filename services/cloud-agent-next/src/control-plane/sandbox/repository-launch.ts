import type { StartupMode } from '../../sandbox-control/startup-selection.js';
import type { ProviderStartSource } from '../../sandbox-control/provider.js';

const LAUNCH_KEY = 'repository_launch';

/**
 * Durable diagnostic and confirmation of how the current allocation started.
 * It never decides the next startup source: a workspace tail descriptor, an
 * environment that requires a build, or the base image do that on every launch.
 */
export type RepositoryLaunchRecord = {
  allocationId: string;
  /** Legacy records used the preinstalled runtime. */
  startupMode?: StartupMode;
  /** Absent in the placeholder written before `launch` reports the source. */
  startSource?: ProviderStartSource;
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

export async function beginRepositoryLaunch(
  storage: Pick<DurableObjectStorage, 'put'>,
  allocationId: string,
  startupMode: StartupMode = 'preinstalled'
): Promise<void> {
  await recordRepositoryLaunch(storage, {
    allocationId,
    startupMode,
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

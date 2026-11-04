import type { StartupMode } from '../../sandbox-control/startup-selection.js';
import type { ProviderStartSource } from '../../sandbox-control/provider.js';
import type { ControlPlaneWorkspaceFailureSubtype } from '../../shared/control-plane-protocol.js';

const LAUNCH_KEY = 'repository_launch';

export type RepositoryPreparationFailure = {
  sessionId: string;
  attemptId: string;
  subtype?: ControlPlaneWorkspaceFailureSubtype;
};

export type RepositoryLaunchRecord = {
  allocationId: string;
  /** Legacy records used the preinstalled runtime. */
  startupMode?: StartupMode;
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
  skipRepository: boolean,
  startupMode: StartupMode = 'preinstalled'
): Promise<void> {
  await recordRepositoryLaunch(storage, {
    allocationId,
    startupMode,
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

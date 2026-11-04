import type { SessionEnvironmentReference } from '../../environment-build/reference.js';
import type { ControlPlaneRouteSpec } from '../../shared/control-plane-protocol.js';
import type { RepositoryLaunchRecord } from './repository-launch.js';

/**
 * Whether the allocation launched from an environment snapshot of the route's
 * environment at the route's revision. Equal revisions mean the snapshot ran
 * the same setup commands with the same variables. An image fallback leaves the
 * wrapper with no snapshot workspace, so the marker has no effect there.
 */
export function environmentSnapshotCurrent(input: {
  environment: SessionEnvironmentReference | null;
  launch: RepositoryLaunchRecord | undefined;
  allocationId: string | null;
}): boolean {
  const { environment, launch } = input;
  const snapshot = launch?.environmentSnapshot;
  return (
    environment !== null &&
    snapshot !== undefined &&
    launch?.allocationId === input.allocationId &&
    launch.startSource !== 'image' &&
    snapshot.environmentId === environment.environmentId &&
    snapshot.revision === environment.configurationRevision
  );
}

/**
 * The setup and start fields of a wrapper frame. A wrapper that runs start
 * commands gets them separately, plus the snapshot marker when it applies. An
 * older wrapper gets them appended to setup, so it still runs every command
 * on every preparation, as before start commands existed.
 */
export function environmentPhaseSpec(input: {
  spec: ControlPlaneRouteSpec;
  environment: SessionEnvironmentReference | null;
  launch: RepositoryLaunchRecord | undefined;
  allocationId: string | null;
  runsStartCommands: boolean;
}): ControlPlaneRouteSpec {
  const { startCommands, environmentSnapshotCurrent: _stored, ...rest } = input.spec;
  if (input.runsStartCommands) {
    return {
      ...rest,
      ...(startCommands === undefined ? {} : { startCommands }),
      ...(environmentSnapshotCurrent(input) ? { environmentSnapshotCurrent: true } : {}),
    };
  }
  if (startCommands === undefined || startCommands.length === 0) return rest;
  return { ...rest, setupCommands: [...(rest.setupCommands ?? []), ...startCommands] };
}

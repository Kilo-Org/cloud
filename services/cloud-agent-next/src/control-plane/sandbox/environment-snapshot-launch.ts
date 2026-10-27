import { environmentSnapshotName } from '../../shared/environment-snapshot-name.js';
import { withTimeout } from '@kilocode/worker-utils';
import type { EnvironmentBuild } from '../../environment-build/environment-build-do.js';
import type { SnapshotAdmission, SnapshotResolution } from '../../environment-build/coordinator.js';
import { SNAPSHOT_LOOKUP_BUDGET_MS } from '../../environment-build/policy.js';
import type { SessionEnvironmentReference } from '../../environment-build/reference.js';
import type { ProviderSnapshotStart } from '../../sandbox-control/provider.js';
import { ISOLATED_CONTAINER_WORKSPACE_PATH } from '../../workspace.js';
import type { RepositoryLaunchRecord } from './repository-launch.js';
import type { RouteRecord } from './routes.js';

/**
 * Environment snapshot selection for a new allocation (plan "Session launch").
 * Only isolated repository allocations consume environment snapshots: every
 * route waiting for the allocation must sit at the isolated workspace path and
 * carry the same admitted environment. The lookup is bounded and never waits
 * for a build; a timeout, a miss or an unavailable coordinator is an ordinary
 * start from the image.
 */

export type EnvironmentLaunchCandidate = {
  reference: SessionEnvironmentReference;
  actorUserId: string;
};

export type EnvironmentCandidateResult =
  | { candidate: EnvironmentLaunchCandidate }
  | {
      reason:
        | 'no_preparing_routes'
        | 'no_environment'
        | 'not_isolated'
        | 'multiple_environments'
        | 'no_actor';
    };

export function environmentLaunchCandidate(
  routes: readonly RouteRecord[]
): EnvironmentCandidateResult {
  const preparing = routes.filter(route => route.state === 'preparing');
  if (preparing.length === 0) return { reason: 'no_preparing_routes' };
  if (preparing.some(route => route.spec.directory !== ISOLATED_CONTAINER_WORKSPACE_PATH)) {
    return { reason: 'not_isolated' };
  }
  const [first] = preparing;
  const reference = first?.environment ?? null;
  if (reference === null) return { reason: 'no_environment' };
  const same = preparing.every(
    route =>
      route.environment !== null &&
      route.environment.environmentId === reference.environmentId &&
      route.environment.configurationRevision === reference.configurationRevision &&
      route.environment.owner.type === reference.owner.type &&
      route.environment.owner.id === reference.owner.id
  );
  if (!same) return { reason: 'multiple_environments' };
  const actorUserId = first?.credentialSource?.userId;
  if (actorUserId === undefined) return { reason: 'no_actor' };
  return { candidate: { reference, actorUserId } };
}

/**
 * The previous snapshot start of this sandbox never connected or its preparation
 * failed: this start uses the image once (one fresh fallback, plan "If snapshot
 * restore fails, retry fresh once"). A completed image start clears it.
 */
export function previousSnapshotStartFailed(previous: RepositoryLaunchRecord | undefined): boolean {
  return (
    previous?.skipRepository === true ||
    (previous?.startSource === 'repository' && !previous.confirmed) ||
    (previous?.startSource !== 'image' && (previous?.preparationFailures?.length ?? 0) > 0)
  );
}

export type EnvironmentLookup =
  | { kind: 'resolved'; resolution: SnapshotResolution }
  | { kind: 'timeout' }
  | { kind: 'unavailable' };

/**
 * One bounded lookup: at most `SNAPSHOT_LOOKUP_BUDGET_MS`, capped by what is left
 * of the launch deadline. A timeout does not cancel coordinator work; admission
 * is idempotent, so a later lookup returns the same build.
 */
export async function lookupEnvironmentSnapshot(input: {
  namespace: DurableObjectNamespace<EnvironmentBuild> | undefined;
  candidate: EnvironmentLaunchCandidate;
  launchDeadlineAt: number;
  now?: () => number;
}): Promise<EnvironmentLookup> {
  const now = input.now ?? Date.now;
  if (input.namespace === undefined) return { kind: 'unavailable' };
  const deadlineAt = Math.min(now() + SNAPSHOT_LOOKUP_BUDGET_MS, input.launchDeadlineAt);
  const stub = input.namespace.getByName(input.candidate.reference.environmentId);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remaining = deadlineAt - now();
    if (remaining <= 0) return { kind: 'timeout' };
    let timedOut = false;
    try {
      const resolution = (await withTimeout(
        stub.resolveSnapshot({
          reference: input.candidate.reference,
          actorUserId: input.candidate.actorUserId,
        }),
        remaining,
        'Environment snapshot lookup timed out',
        () => {
          timedOut = true;
        }
      )) as SnapshotResolution;
      return { kind: 'resolved', resolution };
    } catch {
      if (timedOut) return { kind: 'timeout' };
    }
  }
  return { kind: 'unavailable' };
}

export function snapshotStart(resolution: SnapshotResolution): ProviderSnapshotStart | undefined {
  return resolution.snapshot === null
    ? undefined
    : { snapshotId: resolution.snapshot.snapshotId, baseImage: resolution.snapshot.baseImage };
}

function admissionText(admission: SnapshotAdmission): string | null {
  switch (admission.status) {
    case 'admitted':
      return 'a new snapshot build is queued';
    case 'active':
      return 'a replacement build is running';
    case 'not_needed':
      return null;
    case 'skipped':
      switch (admission.reason) {
        case 'backoff':
          return 'the replacement build is waiting after earlier failures';
        case 'container_limit_reached':
          return 'no replacement build started: the container limit is reached';
        case 'build_in_progress':
        case 'cleanup_pending':
          return 'another environment build is still running';
        case 'revision_superseded':
          return 'the environment changed after this session started';
        default:
          return 'no replacement build started';
      }
  }
}

/**
 * The preparation detail shown while the sandbox starts. It names the actual
 * snapshot by capture time and the real replacement build status. Changed
 * settings remain visible without exposing internal configuration revisions.
 */
export function environmentStartDetail(
  reference: SessionEnvironmentReference,
  lookup: EnvironmentLookup
): string {
  if (lookup.kind !== 'resolved') {
    return lookup.kind === 'timeout'
      ? 'Starting fresh: snapshot lookup timed out'
      : 'Starting fresh: snapshot lookup unavailable';
  }
  const { snapshot, admission, reason } = lookup.resolution;
  const build = admissionText(admission);
  if (snapshot === null) {
    const reasons = {
      missing: 'no saved snapshot exists',
      scope_mismatch: 'snapshot belongs to a different environment, owner or repository',
      incompatible: 'snapshot is incompatible with the current image or runtime',
      newer_than_session: 'snapshot uses newer settings than this session',
      expired: 'snapshot has expired',
      deleted: 'environment was deleted',
      unsupported: 'snapshots are not supported for this environment',
      eligible: 'no usable snapshot is available',
    } satisfies Record<SnapshotResolution['reason'], string>;
    return `Starting fresh: ${reasons[reason]}${build === null ? '' : `; ${build}`}`;
  }
  const settings =
    snapshot.revision === reference.configurationRevision
      ? ''
      : '; environment settings have changed; cached files may retain earlier values';
  return `Using snapshot · ${environmentSnapshotName(snapshot.capturedAt)}${settings}${build === null ? '' : `; ${build}`}`;
}

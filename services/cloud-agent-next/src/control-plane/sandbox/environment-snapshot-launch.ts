import { environmentSnapshotName } from '../../shared/environment-snapshot-name.js';
import { withTimeout } from '@kilocode/worker-utils';
import type { EnvironmentBuild } from '../../environment-build/environment-build-do.js';
import type { SnapshotAdmission, SnapshotResolution } from '../../environment-build/coordinator.js';
import { SNAPSHOT_LOOKUP_BUDGET_MS } from '../../environment-build/policy.js';
import {
  sameEnvironmentScope,
  type SessionEnvironmentReference,
} from '../../environment-build/reference.js';
import type { BuildState } from '../../environment-build/sqlite-schema.js';
import type { ProviderSnapshotStart } from '../../sandbox-control/provider.js';
import {
  environmentWorkspaceDirectory,
  ISOLATED_CONTAINER_WORKSPACE_PATH,
} from '../../shared/environment-workspace.js';
import type { RouteRecord } from './routes.js';

export type EnvironmentLaunchCandidate = {
  reference: SessionEnvironmentReference;
  actorUserId: string;
  /**
   * How many leading setup commands the admitted environment supplies. A
   * non-zero count means the session may only start from that environment's
   * published snapshot; a miss is a failure, never a base-image start.
   */
  buildCommands: number;
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

/** Whether a route sits at the cwd an isolated sandbox gives its admitted environment. */
function routeAtExpectedDirectory(route: RouteRecord): boolean {
  return (
    route.spec.directory ===
    environmentWorkspaceDirectory({
      sessionDirectory: ISOLATED_CONTAINER_WORKSPACE_PATH,
      environment: route.environment,
    })
  );
}

export function environmentLaunchCandidate(
  routes: readonly RouteRecord[]
): EnvironmentCandidateResult {
  const preparing = routes.filter(route => route.state === 'preparing');
  if (preparing.length === 0) return { reason: 'no_preparing_routes' };
  if (preparing.some(route => !routeAtExpectedDirectory(route))) {
    return { reason: 'not_isolated' };
  }
  const [first] = preparing;
  const reference = first?.environment ?? null;
  if (reference === null) return { reason: 'no_environment' };
  // One snapshot serves the routes only when they admitted the same environment
  // at the same revision: a route on another revision may need other setup.
  const same = preparing.every(
    route =>
      route.environment !== null &&
      route.environment.configurationRevision === reference.configurationRevision &&
      sameEnvironmentScope(route.environment, reference)
  );
  if (!same) return { reason: 'multiple_environments' };
  const actorUserId = first?.credentialSource?.userId;
  if (actorUserId === undefined) return { reason: 'no_actor' };
  const buildCommands = Math.max(
    ...preparing.map(route => route.spec.environmentSetupCommandCount ?? 0)
  );
  return { candidate: { reference, actorUserId, buildCommands } };
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

/**
 * The snapshot a session starts from. During the image rollout window the
 * coordinator may publish an older snapshot as compatible; the container
 * restore does not use that image, and startup installs the current runtime
 * over the restored disk, so the provider receives the current image identity.
 */
export function snapshotStart(resolution: SnapshotResolution): ProviderSnapshotStart | undefined {
  if (resolution.snapshot === null) return undefined;
  const baseImage =
    resolution.snapshot.stale === 'image'
      ? (resolution.currentBaseImage ?? resolution.snapshot.baseImage)
      : resolution.snapshot.baseImage;
  return { snapshotId: resolution.snapshot.snapshotId, baseImage };
}

export type EnvironmentSnapshotBlockReason =
  | 'environment_lookup_timeout'
  | 'environment_lookup_unavailable'
  | 'environment_not_built'
  | 'environment_building'
  | 'environment_build_failed'
  | 'environment_build_backoff'
  | 'environment_build_unavailable'
  | 'environment_snapshot_expired'
  | 'environment_snapshot_incompatible'
  | 'environment_snapshot_unavailable'
  | 'environment_snapshot_start_failed'
  | 'environment_not_supported';

/**
 * A blocked start for an environment that has build commands. `environmentId`
 * and `buildId` identify the build a client links to; there is no URL route for
 * the environment build, so the client opens its build panel from these values.
 */
export type EnvironmentSnapshotBlock = {
  reason: EnvironmentSnapshotBlockReason;
  detail: string;
  environmentId: string;
  buildId: string | null;
};

export type EnvironmentSnapshotDecision =
  | { kind: 'start'; snapshot: ProviderSnapshotStart | undefined; detail: string }
  | { kind: 'blocked'; block: EnvironmentSnapshotBlock };

function admissionText(admission: SnapshotAdmission): string | null {
  switch (admission.status) {
    case 'admitted':
      return 'a replacement build was started';
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

function blockedDetail(sentence: string, buildId: string | null): string {
  return buildId === null ? sentence : `${sentence} Build ${buildId}.`;
}

function buildIdOf(resolution: SnapshotResolution): string | null {
  if (resolution.admission.status === 'admitted' || resolution.admission.status === 'active') {
    return resolution.admission.buildId;
  }
  return resolution.build?.buildId ?? null;
}

const TERMINAL_BUILD_STATES: ReadonlySet<BuildState> = new Set([
  'succeeded',
  'failed',
  'canceled',
  'obsolete',
]);

function buildIsActive(resolution: SnapshotResolution): boolean {
  return resolution.build != null && !TERMINAL_BUILD_STATES.has(resolution.build.state);
}

function blockedEnvironment(
  candidate: EnvironmentLaunchCandidate,
  resolution: SnapshotResolution
): EnvironmentSnapshotBlock {
  const environmentId = candidate.reference.environmentId;
  const buildId = buildIdOf(resolution);
  switch (resolution.reason) {
    case 'unsupported':
      return {
        reason: 'environment_not_supported',
        detail: 'Environment snapshots are unavailable for this environment.',
        environmentId,
        buildId,
      };
    case 'deleted':
      return {
        reason: 'environment_snapshot_unavailable',
        detail: 'The environment was deleted.',
        environmentId,
        buildId,
      };
    case 'scope_mismatch':
    case 'newer_than_session':
      return {
        reason: 'environment_snapshot_unavailable',
        detail: 'The published environment snapshot cannot be used for this session.',
        environmentId,
        buildId,
      };
    case 'expired':
      return {
        reason: 'environment_snapshot_expired',
        detail: blockedDetail('The environment snapshot expired.', buildId),
        environmentId,
        buildId,
      };
    case 'incompatible':
      return {
        reason: 'environment_snapshot_incompatible',
        detail: blockedDetail(
          'The environment snapshot was built for an earlier image and is outside the rollout window.',
          buildId
        ),
        environmentId,
        buildId,
      };
    case 'missing':
      break;
  }
  switch (resolution.admission.status) {
    case 'admitted':
    case 'active':
      return {
        reason: 'environment_building',
        detail: blockedDetail('The environment is building.', buildId),
        environmentId,
        buildId,
      };
    case 'skipped':
      switch (resolution.admission.reason) {
        case 'backoff':
          if (buildIsActive(resolution)) {
            return {
              reason: 'environment_building',
              detail: blockedDetail('The environment is building.', buildId),
              environmentId,
              buildId,
            };
          }
          return resolution.build?.state === 'failed' || resolution.build?.outcome === 'failed'
            ? {
                reason: 'environment_build_failed',
                detail: blockedDetail('The environment build failed.', buildId),
                environmentId,
                buildId,
              }
            : {
                reason: 'environment_build_backoff',
                detail: blockedDetail(
                  'The environment build is waiting after earlier failures.',
                  buildId
                ),
                environmentId,
                buildId,
              };
        case 'container_limit_reached':
          return {
            reason: 'environment_build_unavailable',
            detail: blockedDetail(
              'The environment build cannot start because the container limit is reached.',
              buildId
            ),
            environmentId,
            buildId,
          };
        case 'build_in_progress':
        case 'cleanup_pending':
          return {
            reason: 'environment_building',
            detail: blockedDetail('The environment is building.', buildId),
            environmentId,
            buildId,
          };
        case 'unsupported':
          return {
            reason: 'environment_not_supported',
            detail: 'Environment snapshots are unavailable for this environment.',
            environmentId,
            buildId,
          };
        case 'revision_superseded':
          return {
            reason: 'environment_snapshot_unavailable',
            detail: blockedDetail(
              'The environment changed after this session started and has no usable snapshot.',
              buildId
            ),
            environmentId,
            buildId,
          };
        case 'environment_deleted':
          return {
            reason: 'environment_snapshot_unavailable',
            detail: 'The environment was deleted.',
            environmentId,
            buildId,
          };
        case 'unavailable':
          return {
            reason: 'environment_build_unavailable',
            detail: blockedDetail('The environment build is unavailable.', buildId),
            environmentId,
            buildId,
          };
      }
      break;
    case 'not_needed':
      return {
        reason: 'environment_not_built',
        detail: blockedDetail('The environment is not built.', buildId),
        environmentId,
        buildId,
      };
  }
}

function blockedLookup(
  candidate: EnvironmentLaunchCandidate,
  lookup: { kind: 'timeout' } | { kind: 'unavailable' }
): EnvironmentSnapshotBlock {
  return {
    reason:
      lookup.kind === 'timeout' ? 'environment_lookup_timeout' : 'environment_lookup_unavailable',
    detail:
      lookup.kind === 'timeout'
        ? 'The environment snapshot lookup timed out. The environment must be built before this session can start.'
        : 'The environment snapshot lookup is unavailable. The environment must be built before this session can start.',
    environmentId: candidate.reference.environmentId,
    buildId: null,
  };
}

/** The final state after a required environment snapshot start failed and was not retried again. */
export function environmentSnapshotStartBlock(
  candidate: EnvironmentLaunchCandidate,
  buildId: string | null
): EnvironmentSnapshotBlock {
  return {
    reason: 'environment_snapshot_start_failed',
    detail: blockedDetail(
      'The environment snapshot could not start. Rebuild the environment.',
      buildId
    ),
    environmentId: candidate.reference.environmentId,
    buildId,
  };
}
/**
 * The startup source for an environment session. An environment with build
 * commands must start from its compatible published snapshot: a miss, a build
 * in progress, a failed build or an unavailable lookup blocks the start with a
 * precise reason and the build to open. Environments without build commands
 * keep the ordinary image start.
 */
export function environmentSnapshotDecision(
  candidate: EnvironmentLaunchCandidate,
  lookup: EnvironmentLookup
): EnvironmentSnapshotDecision {
  if (lookup.kind !== 'resolved') {
    return candidate.buildCommands === 0
      ? {
          kind: 'start',
          snapshot: undefined,
          detail: environmentStartDetail(candidate.reference, lookup),
        }
      : { kind: 'blocked', block: blockedLookup(candidate, lookup) };
  }
  const snapshot = snapshotStart(lookup.resolution);
  if (candidate.buildCommands === 0 || snapshot !== undefined) {
    return {
      kind: 'start',
      snapshot,
      detail: environmentStartDetail(candidate.reference, lookup),
    };
  }
  return { kind: 'blocked', block: blockedEnvironment(candidate, lookup.resolution) };
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
    return 'Starting without an environment snapshot (lookup unavailable)';
  }
  const { snapshot, admission } = lookup.resolution;
  const build = admissionText(admission);
  if (snapshot === null) {
    return `Starting without an environment snapshot${build === null ? '' : `; ${build}`}`;
  }
  const settings =
    snapshot.revision === reference.configurationRevision
      ? ''
      : '; environment settings have changed; cached files may retain earlier values';
  const image =
    snapshot.stale === 'image'
      ? '; built for an earlier image; using it during the rollout window'
      : '';
  return `Using snapshot · ${environmentSnapshotName(snapshot.capturedAt)}${image}${settings}${build === null ? '' : `; ${build}`}`;
}

import type {
  EnvironmentBuildRequestResult,
  EnvironmentBuildStatus,
  EnvironmentBuildSummary,
} from '../../../../../services/cloud-agent-next/src/shared/environment-build-status';

/**
 * Presentation rules for environment snapshot builds, kept free of React so
 * they are unit-tested. Copy follows the plan's environment settings notices.
 */

export type { EnvironmentBuildRequestResult, EnvironmentBuildStatus, EnvironmentBuildSummary };

export const SNAPSHOT_REUSE_NOTICE =
  'Cached files may retain old values, including secrets. Refresh the snapshot to replace them.';

const ACTIVE_STATES: ReadonlySet<EnvironmentBuildSummary['state']> = new Set([
  'queued',
  'preparing',
  'capturing',
  'publishing',
  'stopping',
]);

export function isBuildActive(summary: EnvironmentBuildSummary | null | undefined): boolean {
  return summary !== null && summary !== undefined && ACTIVE_STATES.has(summary.state);
}

/** The one line that names what a build is doing now, or how it ended. */
export function buildStageLabel(summary: EnvironmentBuildSummary): string {
  switch (summary.state) {
    case 'queued':
      return 'Queued';
    case 'preparing':
      if (summary.step === 'clone') return 'Cloning the default branch';
      if (summary.step === 'setup') return 'Running setup commands';
      if (summary.step === 'cleanup') return 'Removing credentials';
      return 'Starting the builder';
    case 'capturing':
      return 'Capturing the snapshot';
    case 'publishing':
      return 'Publishing the snapshot';
    case 'stopping':
      switch (summary.outcome) {
        case 'succeeded':
          return 'Published; stopping the builder';
        case 'canceled':
          return 'Canceling';
        default:
          return summary.cleanup === 'failing'
            ? 'Stopping the builder (retrying)'
            : 'Stopping the builder';
      }
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'canceled':
      return 'Canceled';
    case 'obsolete':
      return 'Superseded';
  }
}

const FAILURE_TEXT: Record<string, string> = {
  clone_failed: 'The repository could not be cloned.',
  setup_failed: 'A setup command failed. See the build log.',
  setup_timeout: 'A setup command timed out. See the build log.',
  cleanup_failed: 'Credentials could not be removed, so no snapshot was taken.',
  capture_failed: 'The snapshot could not be captured.',
  capture_uncertain: 'The snapshot result was lost; the build was not published.',
  deadline: 'The build did not finish within 30 minutes.',
  builder_lost: 'The builder stopped reporting.',
  builder_start_failed: 'The builder could not start.',
  input_unavailable: 'The builder could not read its inputs.',
  repository_unauthorized: 'Repository access is no longer authorized.',
  actor_unauthorized: 'The person who started the build no longer has access.',
  billing_blocked: 'Builds need available credits.',
  billing_unavailable: 'Billing could not admit the build. Try again.',
  container_limit_reached: 'The concurrent container limit is reached.',
  configuration_changed: 'The configuration changed during the build.',
  environment_deleted: 'The environment was deleted.',
  canceled: 'The build was canceled.',
  not_found: 'The environment was not found.',
  unsupported_provider: 'Snapshot builds are unavailable for this account.',
};

export function failureText(reason: string | null): string | null {
  if (reason === null) return null;
  if (reason.startsWith('runtime_')) return 'The selected runtime release could not be installed.';
  return FAILURE_TEXT[reason] ?? 'The build failed.';
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function formatAge(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function stalenessText(status: EnvironmentBuildStatus): string | null {
  switch (status.published?.stale) {
    case 'revision':
      return 'Environment settings have changed. Refresh the snapshot to include them.';
    case 'age':
      return 'The snapshot is older than four days; the next session starts a refresh.';
    case 'image':
      return 'The snapshot was built for an earlier sandbox image. Sessions start without it until a refresh completes.';
    default:
      return null;
  }
}

/** Automatic builds paused for a revision; a manual build still runs. */
export function backoffText(
  backoff: NonNullable<EnvironmentBuildStatus['automaticBackoff']>
): string {
  const attempts =
    backoff.failures === 1 ? '1 failed attempt' : `${backoff.failures} failed attempts`;
  const at = new Date(backoff.nextAttemptAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Automatic builds paused after ${attempts}. Next attempt: ${at}. You can still build manually.`;
}

export type BuildAction =
  | { kind: 'build' | 'refresh'; disabledReason: string | null }
  | { kind: 'cancel'; buildId: string }
  | { kind: 'none'; reason: string };

/**
 * The one control the build detail and the environment menu show. A build needs
 * saved configuration and a supported provider; a running build can be canceled;
 * a build that is cleaning up blocks a new one.
 */
export function buildAction(
  status: EnvironmentBuildStatus | undefined,
  options: { canManage: boolean; hasUnsavedChanges: boolean }
): BuildAction {
  if (!options.canManage) return { kind: 'none', reason: 'Only managers can build snapshots.' };
  if (status === undefined) return { kind: 'none', reason: 'Loading build status.' };
  if (!status.supported) {
    return { kind: 'none', reason: status.unsupportedReason ?? 'Snapshot builds are unavailable.' };
  }
  const active = status.activeBuild;
  if (active !== null) {
    if (active.state === 'stopping') {
      return { kind: 'none', reason: 'Wait for the builder to stop before building again.' };
    }
    return { kind: 'cancel', buildId: active.buildId };
  }
  return {
    kind: status.published === null ? 'build' : 'refresh',
    disabledReason: options.hasUnsavedChanges ? 'Save your changes before building.' : null,
  };
}

/** Short status for the environment list row. */
export function snapshotBadge(
  status: EnvironmentBuildStatus | undefined,
  now: number
): string | null {
  if (status === undefined || !status.supported) return null;
  if (isBuildActive(status.activeBuild)) return 'Building snapshot';
  if (status.published === null) {
    return status.latestBuild?.state === 'failed' ? 'Snapshot build failed' : 'No snapshot';
  }
  const age = formatAge(status.published.capturedAt, now);
  return status.published.stale === null ? `Snapshot ${age}` : `Snapshot ${age} (stale)`;
}

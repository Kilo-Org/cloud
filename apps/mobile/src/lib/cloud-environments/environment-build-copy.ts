// The vocabulary of an environment snapshot build, for the new-session picker
// and its detail sheet. Ported from the web's `environment-build-display.ts`:
// the same states map to the same meaning, and a reason the table below does
// not cover reads as the web's own generic failure sentence.
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { type TFunction } from 'i18next';

export type EnvironmentBuildStatusRow =
  inferRouterOutputs<MobileRouter>['cloudEnvironments']['buildStatus'];
export type EnvironmentBuildSummaryRow = NonNullable<EnvironmentBuildStatusRow['latestBuild']>;

const ACTIVE_STATES = {
  queued: true,
  preparing: true,
  capturing: true,
  publishing: true,
  stopping: true,
  succeeded: false,
  failed: false,
  canceled: false,
  obsolete: false,
} satisfies Record<EnvironmentBuildSummaryRow['state'], boolean>;

export function isBuildActive(
  summary: EnvironmentBuildSummaryRow | null | undefined
): summary is EnvironmentBuildSummaryRow {
  return summary !== null && summary !== undefined && ACTIVE_STATES[summary.state];
}

/** The one line that names what a build is doing now, or how it ended. */
const SIMPLE_STAGE_KEYS = {
  queued: 'common.queued',
  capturing: 'agentChat.environment.buildCapturing',
  publishing: 'agentChat.environment.buildPublishing',
  succeeded: 'agentChat.environment.buildSucceeded',
  failed: 'common.failed',
  canceled: 'common.cancelled',
  obsolete: 'agentChat.environment.buildSuperseded',
} satisfies Record<Exclude<EnvironmentBuildSummaryRow['state'], 'preparing' | 'stopping'>, string>;

export function buildStageLabel(summary: EnvironmentBuildSummaryRow, t: TFunction): string {
  if (summary.state === 'preparing') {
    if (summary.step === 'clone') {
      return t('agentChat.environment.buildCloning');
    }
    if (summary.step === 'setup') {
      return t('agentChat.environment.buildSetup');
    }
    if (summary.step === 'cleanup') {
      return t('agentChat.environment.buildCleanup');
    }
    return t('agentChat.environment.buildPreparing');
  }
  if (summary.state === 'stopping') {
    if (summary.outcome === 'succeeded') {
      return t('agentChat.environment.buildFinishing');
    }
    if (summary.outcome === 'canceled') {
      return t('common.cancelled');
    }
    return summary.cleanup === 'failing'
      ? t('agentChat.environment.buildStoppingRetrying')
      : t('agentChat.environment.buildStopping');
  }
  return t(SIMPLE_STAGE_KEYS[summary.state]);
}

const FAILURE_KEYS = {
  clone_failed: 'agentChat.environment.failureClone',
  setup_failed: 'agentChat.environment.failureSetup',
  setup_timeout: 'agentChat.environment.failureTimeout',
  cleanup_failed: 'agentChat.environment.failureCleanup',
  capture_failed: 'agentChat.environment.failureCapture',
  capture_uncertain: 'agentChat.environment.failureCapture',
  deadline: 'agentChat.environment.failureDeadline',
  builder_lost: 'agentChat.environment.failureBuilderLost',
  builder_start_failed: 'agentChat.environment.failureBuilderLost',
  repository_unauthorized: 'agentChat.environment.failureUnauthorized',
  actor_unauthorized: 'agentChat.environment.failureUnauthorized',
  billing_blocked: 'agentChat.environment.failureBilling',
  billing_unavailable: 'agentChat.environment.failureBilling',
  configuration_changed: 'agentChat.environment.failureConfiguration',
} satisfies Record<string, string>;

export function buildFailureText(reason: string | null, t: TFunction): string | null {
  if (reason === null) {
    return null;
  }
  if (reason.startsWith('runtime_')) {
    return t('agentChat.environment.failureRuntime');
  }
  // The worker's reasons are an open set, so an unknown one keeps web's own
  // generic sentence rather than leaking a code onto the screen.
  const key = Object.hasOwn(FAILURE_KEYS, reason)
    ? FAILURE_KEYS[reason as keyof typeof FAILURE_KEYS]
    : 'agentChat.environment.failureGeneric';
  return t(key);
}

/**
 * The build line the picker row and the detail sheet's summary show: what the
 * build is doing, how the last one ended, or how the published snapshot
 * stands.
 */
export function buildSummaryLabel(
  status: EnvironmentBuildStatusRow | undefined,
  t: TFunction
): string {
  if (status === undefined) {
    return t('common.loading');
  }
  if (!status.supported) {
    return t('agentChat.environment.buildUnavailableShort');
  }
  if (status.activeBuild !== null) {
    return buildStageLabel(status.activeBuild, t);
  }
  const latest = status.latestBuild;
  if (latest !== null && latest.state !== 'succeeded') {
    return buildStageLabel(latest, t);
  }
  if (status.published !== null) {
    return status.published.stale === null
      ? t('agentChat.environment.buildSucceeded')
      : t('agentChat.environment.buildStale');
  }
  return t('agentChat.environment.buildNotBuilt');
}

/**
 * The single build control the detail sheet shows. A build needs a supported
 * provider and a saved configuration; a running build can be canceled; a build
 * that is cleaning up blocks a new one. `canManage` is the web's own gate: an
 * organization member without a managing role never sees the control.
 */
export type EnvironmentBuildAction =
  | { kind: 'build' | 'refresh' }
  | { kind: 'cancel'; buildId: string }
  | { kind: 'none'; message: string };

export function environmentBuildAction(
  status: EnvironmentBuildStatusRow | undefined,
  options: { canManage: boolean },
  t: TFunction
): EnvironmentBuildAction {
  if (!options.canManage) {
    return { kind: 'none', message: t('agentChat.environment.onlyManagersCanBuild') };
  }
  if (status === undefined) {
    return { kind: 'none', message: t('common.loading') };
  }
  if (!status.supported) {
    return { kind: 'none', message: t('agentChat.environment.buildsUnavailable') };
  }
  const active = status.activeBuild;
  if (active !== null) {
    return active.state === 'stopping'
      ? { kind: 'none', message: t('agentChat.environment.waitForBuilder') }
      : { kind: 'cancel', buildId: active.buildId };
  }
  return { kind: status.published === null ? 'build' : 'refresh' };
}

import type {
  VercelComputeSetupStatus,
  VercelComputeSetupStep,
  VercelComputeUpgradeStatus,
} from '@kilocode/db/schema-types';

export type VercelComputeStatusProjection = {
  setupStatus: VercelComputeSetupStatus;
  setupStep: VercelComputeSetupStep | null;
  setupError: string | null;
  teamSlug: string | null;
  projectSlug: string | null;
  runtimeBuildId: string | null;
  runtimeSnapshotId: string | null;
  setupStartedAt: string | null;
  setupCompletedAt: string | null;
  runtimeWrapperVersion: string | null;
  runtimeReleasedAt: string | null;
  runtimeDigest: string | null;
};

export type VercelComputeStatusRow = {
  setup_status: VercelComputeSetupStatus;
  setup_step: VercelComputeSetupStep | null;
  setup_error: string | null;
  team_slug: string | null;
  project_slug: string | null;
  runtime_build_id: string | null;
  runtime_snapshot_id: string | null;
  runtime_wrapper_version: string | null;
  runtime_released_at: string | null;
  runtime_digest: string | null;
  upgrade_status: VercelComputeUpgradeStatus | null;
  upgrade_step: VercelComputeSetupStep | null;
  upgrade_error: string | null;
  setup_started_at: string | null;
  setup_completed_at: string | null;
};

export type VercelComputeStatusColumns = {
  setup_status: VercelComputeSetupStatus;
  setup_step: VercelComputeSetupStep | null;
  setup_error: string | null;
  team_slug: string | null;
  project_slug: string | null;
  runtime_build_id: string | null;
  runtime_snapshot_id: string | null;
  runtime_wrapper_version: string | null;
  runtime_released_at: string | null;
  runtime_digest: string | null;
  upgrade_status: VercelComputeUpgradeStatus | null;
  upgrade_step: VercelComputeSetupStep | null;
  upgrade_error: string | null;
  setup_started_at: string | null;
  setup_completed_at: string | null;
};

export function applyVercelComputeStatusProjection(
  current: VercelComputeStatusRow,
  data: VercelComputeStatusProjection
): VercelComputeStatusColumns {
  if (data.setupStatus === 'failed' && data.setupError === 'byoc_vercel_snapshot_missing') {
    return {
      setup_status: 'failed',
      setup_step: null,
      setup_error: data.setupError,
      team_slug: data.teamSlug,
      project_slug: data.projectSlug,
      runtime_build_id: data.runtimeBuildId,
      runtime_snapshot_id: null,
      runtime_wrapper_version: current.runtime_wrapper_version,
      runtime_released_at: current.runtime_released_at,
      runtime_digest: current.runtime_digest,
      upgrade_status: null,
      upgrade_step: null,
      upgrade_error: null,
      setup_started_at: data.setupStartedAt,
      setup_completed_at: null,
    };
  }

  if (current.setup_status === 'ready' && data.setupStatus === 'failed') {
    return {
      setup_status: 'ready',
      setup_step: current.setup_step,
      setup_error: current.setup_error,
      team_slug: data.teamSlug ?? current.team_slug,
      project_slug: data.projectSlug ?? current.project_slug,
      runtime_build_id: current.runtime_build_id,
      runtime_snapshot_id: current.runtime_snapshot_id,
      runtime_wrapper_version: current.runtime_wrapper_version,
      runtime_released_at: current.runtime_released_at,
      runtime_digest: current.runtime_digest,
      upgrade_status: 'failed',
      upgrade_step: null,
      upgrade_error: data.setupError,
      setup_started_at: current.setup_started_at,
      setup_completed_at: current.setup_completed_at,
    };
  }

  if (current.setup_status === 'ready' && data.setupStatus !== 'ready') {
    return {
      setup_status: 'ready',
      setup_step: current.setup_step,
      setup_error: current.setup_error,
      team_slug: data.teamSlug ?? current.team_slug,
      project_slug: data.projectSlug ?? current.project_slug,
      runtime_build_id: current.runtime_build_id,
      runtime_snapshot_id: current.runtime_snapshot_id,
      runtime_wrapper_version: current.runtime_wrapper_version,
      runtime_released_at: current.runtime_released_at,
      runtime_digest: current.runtime_digest,
      upgrade_status: data.setupStatus === 'pending' ? 'pending' : 'building',
      upgrade_step: data.setupStep,
      upgrade_error: null,
      setup_started_at: current.setup_started_at,
      setup_completed_at: current.setup_completed_at,
    };
  }

  if (current.setup_status === 'ready' && data.setupStatus === 'ready') {
    return {
      setup_status: 'ready',
      setup_step: null,
      setup_error: null,
      team_slug: data.teamSlug,
      project_slug: data.projectSlug,
      runtime_build_id: data.runtimeBuildId,
      runtime_snapshot_id: data.runtimeSnapshotId,
      runtime_wrapper_version: data.runtimeWrapperVersion,
      runtime_released_at: data.runtimeReleasedAt,
      runtime_digest: data.runtimeDigest,
      upgrade_status: null,
      upgrade_step: null,
      upgrade_error: null,
      setup_started_at: current.setup_started_at,
      setup_completed_at: data.setupCompletedAt,
    };
  }

  return {
    setup_status: data.setupStatus,
    setup_step: data.setupStep,
    setup_error: data.setupError,
    team_slug: data.teamSlug,
    project_slug: data.projectSlug,
    runtime_build_id: data.runtimeBuildId,
    runtime_snapshot_id: data.runtimeSnapshotId,
    runtime_wrapper_version:
      data.setupStatus === 'ready' ? data.runtimeWrapperVersion : current.runtime_wrapper_version,
    runtime_released_at:
      data.setupStatus === 'ready' ? data.runtimeReleasedAt : current.runtime_released_at,
    runtime_digest: data.setupStatus === 'ready' ? data.runtimeDigest : current.runtime_digest,
    upgrade_status: null,
    upgrade_step: null,
    upgrade_error: null,
    setup_started_at: data.setupStartedAt,
    setup_completed_at: data.setupCompletedAt,
  };
}

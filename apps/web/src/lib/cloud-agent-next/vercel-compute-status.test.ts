import { applyVercelComputeStatusProjection } from './vercel-compute-status';

describe('applyVercelComputeStatusProjection', () => {
  const ready = {
    setup_status: 'ready' as const,
    setup_step: null,
    setup_error: null,
    team_slug: 'team',
    project_slug: 'project',
    runtime_build_id: 'runtime-old',
    runtime_snapshot_id: 'snapshot-old',
    runtime_wrapper_version: '2.4.0',
    runtime_released_at: '2026-09-01',
    runtime_digest: 'digest-old',
    upgrade_status: null,
    upgrade_step: null,
    upgrade_error: null,
    setup_started_at: '2026-09-01T00:00:00.000Z',
    setup_completed_at: '2026-09-01T01:00:00.000Z',
  };

  const buildingProjection = {
    setupStatus: 'building' as const,
    setupStep: 'create_builder' as const,
    setupError: null,
    teamSlug: 'team',
    projectSlug: 'project',
    runtimeBuildId: 'runtime-new',
    runtimeSnapshotId: null,
    setupStartedAt: '2026-09-08T00:00:00.000Z',
    setupCompletedAt: null,
    runtimeWrapperVersion: null,
    runtimeReleasedAt: null,
    runtimeDigest: null,
  };

  it('keeps a Ready snapshot while an upgrade is building', () => {
    expect(applyVercelComputeStatusProjection(ready, buildingProjection)).toMatchObject({
      setup_status: 'ready',
      runtime_snapshot_id: 'snapshot-old',
      runtime_digest: 'digest-old',
      upgrade_status: 'building',
      upgrade_step: 'create_builder',
      setup_completed_at: ready.setup_completed_at,
    });
  });

  it('keeps a Ready snapshot when an upgrade build fails', () => {
    expect(
      applyVercelComputeStatusProjection(ready, {
        ...buildingProjection,
        setupStatus: 'failed',
        setupStep: null,
        setupError: 'provider_request_failed',
      })
    ).toMatchObject({
      setup_status: 'ready',
      runtime_snapshot_id: 'snapshot-old',
      upgrade_status: 'failed',
      upgrade_error: 'provider_request_failed',
    });
  });

  it('swaps the Ready snapshot when an upgrade becomes Ready', () => {
    expect(
      applyVercelComputeStatusProjection(
        { ...ready, upgrade_status: 'building' },
        {
          setupStatus: 'ready',
          setupStep: null,
          setupError: null,
          teamSlug: 'team',
          projectSlug: 'project',
          runtimeBuildId: 'runtime-new',
          runtimeSnapshotId: 'snapshot-new',
          setupStartedAt: '2026-09-08T00:00:00.000Z',
          setupCompletedAt: '2026-09-08T01:00:00.000Z',
          runtimeWrapperVersion: '2.4.0',
          runtimeReleasedAt: '2026-09-08',
          runtimeDigest: 'digest-new',
        }
      )
    ).toMatchObject({
      setup_status: 'ready',
      runtime_snapshot_id: 'snapshot-new',
      runtime_digest: 'digest-new',
      runtime_released_at: '2026-09-08',
      upgrade_status: null,
      setup_completed_at: '2026-09-08T01:00:00.000Z',
    });
  });

  it('fails the org when the live snapshot is missing', () => {
    expect(
      applyVercelComputeStatusProjection(
        { ...ready, upgrade_status: 'building' },
        {
          ...buildingProjection,
          setupStatus: 'failed',
          setupStep: null,
          setupError: 'byoc_vercel_snapshot_missing',
        }
      )
    ).toMatchObject({
      setup_status: 'failed',
      runtime_snapshot_id: null,
      setup_error: 'byoc_vercel_snapshot_missing',
      upgrade_status: null,
    });
  });

  it('applies first-time setup projections onto non-ready rows', () => {
    expect(
      applyVercelComputeStatusProjection(
        {
          ...ready,
          setup_status: 'pending',
          runtime_snapshot_id: null,
          runtime_digest: null,
          setup_completed_at: null,
        },
        buildingProjection
      )
    ).toMatchObject({
      setup_status: 'building',
      runtime_snapshot_id: null,
      upgrade_status: null,
    });
  });
});

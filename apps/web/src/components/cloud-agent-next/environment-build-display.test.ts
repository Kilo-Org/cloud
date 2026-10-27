import {
  backoffText,
  buildAction,
  buildStageLabel,
  failureText,
  formatAge,
  snapshotBadge,
  stalenessText,
  type EnvironmentBuildStatus,
  type EnvironmentBuildSummary,
} from './environment-build-display';

const NOW = 1_800_000_000_000;

function summary(overrides: Partial<EnvironmentBuildSummary> = {}): EnvironmentBuildSummary {
  return {
    buildId: '11111111-1111-4111-8111-111111111111',
    revision: 2,
    trigger: 'manual',
    state: 'preparing',
    outcome: null,
    step: null,
    failureReason: null,
    failureDetail: null,
    sourceCommit: null,
    sourceBranch: null,
    setupDurationMs: null,
    createdAt: NOW,
    finishedAt: null,
    cleanup: 'not_started',
    logTruncated: false,
    ...overrides,
  };
}

function status(overrides: Partial<EnvironmentBuildStatus> = {}): EnvironmentBuildStatus {
  return {
    environmentId: '22222222-2222-4222-8222-222222222222',
    supported: true,
    unsupportedReason: null,
    configurationRevision: 2,
    activeBuild: null,
    latestBuild: null,
    published: null,
    automaticBackoff: null,
    ...overrides,
  };
}

const PUBLISHED = {
  buildId: '33333333-3333-4333-8333-333333333333',
  revision: 2,
  sourceCommit: 'a'.repeat(40),
  sourceBranch: 'main',
  capturedAt: NOW - 3 * 60 * 60_000,
  size: 100,
  setupDurationMs: 60_000,
  stale: null,
  expiresAt: NOW,
};

describe('environment build display', () => {
  it('names the active stage from the coordinator state and builder step', () => {
    expect(buildStageLabel(summary({ state: 'queued' }))).toBe('Queued');
    expect(buildStageLabel(summary({ step: 'setup' }))).toBe('Running setup commands');
    expect(buildStageLabel(summary({ state: 'capturing' }))).toBe('Capturing the snapshot');
    expect(buildStageLabel(summary({ state: 'stopping', outcome: 'succeeded' }))).toBe(
      'Published; stopping the builder'
    );
    expect(
      buildStageLabel(summary({ state: 'stopping', outcome: 'failed', cleanup: 'failing' }))
    ).toBe('Stopping the builder (retrying)');
    expect(buildStageLabel(summary({ state: 'obsolete' }))).toBe('Superseded');
  });

  it('offers Build, Refresh or Cancel and requires saved configuration', () => {
    const options = { canManage: true, hasUnsavedChanges: false };
    expect(buildAction(status(), options)).toEqual({ kind: 'build', disabledReason: null });
    expect(buildAction(status({ published: PUBLISHED }), options)).toEqual({
      kind: 'refresh',
      disabledReason: null,
    });
    expect(buildAction(status(), { canManage: true, hasUnsavedChanges: true })).toEqual({
      kind: 'build',
      disabledReason: 'Save your changes before building.',
    });
    expect(buildAction(status({ activeBuild: summary() }), options)).toEqual({
      kind: 'cancel',
      buildId: summary().buildId,
    });
    expect(
      buildAction(status({ activeBuild: summary({ state: 'stopping' }) }), options)
    ).toMatchObject({
      kind: 'none',
    });
    expect(
      buildAction(status({ supported: false, unsupportedReason: 'Not enabled' }), options)
    ).toEqual({ kind: 'none', reason: 'Not enabled' });
    expect(buildAction(status(), { canManage: false, hasUnsavedChanges: false }).kind).toBe('none');
  });

  it('explains when the snapshot does not include the latest settings', () => {
    expect(
      stalenessText(status({ published: { ...PUBLISHED, revision: 1, stale: 'revision' } }))
    ).toBe('Environment settings have changed. Refresh the snapshot to include them.');
    expect(stalenessText(status({ published: PUBLISHED }))).toBeNull();
    expect(stalenessText(status({ published: { ...PUBLISHED, stale: 'image' } }))).toBe(
      'The snapshot was built for an earlier sandbox image. Sessions start without it until a refresh completes.'
    );
  });

  it('names the automatic backoff without blocking a manual build', () => {
    const text = backoffText({ revision: 5, failures: 1, nextAttemptAt: NOW });
    expect(text).toMatch(
      /^Automatic builds paused after 1 failed attempt\. Next attempt: .+\. You can still build manually\.$/
    );
    expect(backoffText({ revision: 5, failures: 3, nextAttemptAt: NOW })).toContain(
      'after 3 failed attempts.'
    );
  });

  it('summarizes the row badge and failures', () => {
    expect(snapshotBadge(status({ published: PUBLISHED }), NOW)).toBe('Snapshot 3 h ago');
    expect(snapshotBadge(status({ activeBuild: summary() }), NOW)).toBe('Building snapshot');
    expect(snapshotBadge(status({ latestBuild: summary({ state: 'failed' }) }), NOW)).toBe(
      'Snapshot build failed'
    );
    expect(snapshotBadge(status({ supported: false }), NOW)).toBeNull();
    expect(failureText('setup_failed')).toBe('A setup command failed. See the build log.');
    expect(failureText('runtime_base_incompatible')).toBe(
      'The selected runtime release could not be installed.'
    );
    expect(formatAge(NOW - 30_000, NOW)).toBe('just now');
  });
});

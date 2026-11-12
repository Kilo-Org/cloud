import { describe, expect, it } from 'vitest';
import { type TFunction } from 'i18next';

import {
  buildFailureText,
  buildStageLabel,
  buildSummaryLabel,
  environmentBuildAction,
  type EnvironmentBuildStatusRow,
  type EnvironmentBuildSummaryRow,
  isBuildActive,
} from './environment-build-copy';

/** The catalog itself is covered by the i18n check; these tests read the key. */
const t = ((key: string) => key) as TFunction;

function build(overrides: Partial<EnvironmentBuildSummaryRow> = {}): EnvironmentBuildSummaryRow {
  return {
    buildId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    trigger: 'manual',
    state: 'preparing',
    outcome: null,
    step: null,
    failureReason: null,
    failureDetail: null,
    sourceCommit: null,
    sourceBranch: null,
    setupDurationMs: null,
    createdAt: 1,
    finishedAt: null,
    cleanup: 'not_started',
    logTruncated: false,
    ...overrides,
  };
}

function status(overrides: Partial<EnvironmentBuildStatusRow> = {}): EnvironmentBuildStatusRow {
  return {
    environmentId: '22222222-2222-4222-8222-222222222222',
    supported: true,
    unsupportedReason: null,
    configurationRevision: 3,
    activeBuild: null,
    latestBuild: null,
    published: null,
    automaticBackoff: null,
    sessionPreparationBudgetMs: 600_000,
    ...overrides,
  };
}

describe('isBuildActive', () => {
  it('treats every non-terminal state as running', () => {
    expect(isBuildActive(build({ state: 'queued' }))).toBe(true);
    expect(isBuildActive(build({ state: 'stopping' }))).toBe(true);
    expect(isBuildActive(build({ state: 'succeeded' }))).toBe(false);
    expect(isBuildActive(build({ state: 'failed' }))).toBe(false);
    expect(isBuildActive(null)).toBe(false);
    expect(isBuildActive(undefined)).toBe(false);
  });
});

describe('buildStageLabel', () => {
  it('names the preparing step the build is on', () => {
    expect(buildStageLabel(build({ state: 'queued' }), t)).toBe('common.queued');
    expect(buildStageLabel(build({ step: 'clone' }), t)).toBe('agentChat.environment.buildCloning');
    expect(buildStageLabel(build({ step: 'setup' }), t)).toBe('agentChat.environment.buildSetup');
    expect(buildStageLabel(build({ step: 'cleanup' }), t)).toBe(
      'agentChat.environment.buildCleanup'
    );
    expect(buildStageLabel(build(), t)).toBe('agentChat.environment.buildPreparing');
  });

  it('names capture, publish and each way a build stops', () => {
    expect(buildStageLabel(build({ state: 'capturing' }), t)).toBe(
      'agentChat.environment.buildCapturing'
    );
    expect(buildStageLabel(build({ state: 'publishing' }), t)).toBe(
      'agentChat.environment.buildPublishing'
    );
    expect(buildStageLabel(build({ state: 'stopping', outcome: 'succeeded' }), t)).toBe(
      'agentChat.environment.buildFinishing'
    );
    expect(buildStageLabel(build({ state: 'stopping', outcome: 'canceled' }), t)).toBe(
      'common.cancelled'
    );
    expect(buildStageLabel(build({ state: 'stopping', cleanup: 'failing' }), t)).toBe(
      'agentChat.environment.buildStoppingRetrying'
    );
    expect(buildStageLabel(build({ state: 'stopping' }), t)).toBe(
      'agentChat.environment.buildStopping'
    );
  });

  it('names each terminal state', () => {
    expect(buildStageLabel(build({ state: 'succeeded' }), t)).toBe(
      'agentChat.environment.buildSucceeded'
    );
    expect(buildStageLabel(build({ state: 'failed' }), t)).toBe('common.failed');
    expect(buildStageLabel(build({ state: 'canceled' }), t)).toBe('common.cancelled');
    expect(buildStageLabel(build({ state: 'obsolete' }), t)).toBe(
      'agentChat.environment.buildSuperseded'
    );
  });
});

describe('buildFailureText', () => {
  it('reads a known reason in the app language', () => {
    expect(buildFailureText('clone_failed', t)).toBe('agentChat.environment.failureClone');
    expect(buildFailureText('setup_timeout', t)).toBe('agentChat.environment.failureTimeout');
    expect(buildFailureText('repository_unauthorized', t)).toBe(
      'agentChat.environment.failureUnauthorized'
    );
  });

  it('gives every runtime reason one sentence and an unknown one the generic failure', () => {
    expect(buildFailureText('runtime_cli_probe_failed', t)).toBe(
      'agentChat.environment.failureRuntime'
    );
    expect(buildFailureText('a_reason_from_a_newer_worker', t)).toBe(
      'agentChat.environment.failureGeneric'
    );
    expect(buildFailureText(null, t)).toBeNull();
  });
});

describe('buildSummaryLabel', () => {
  const published = {
    buildId: '33333333-3333-4333-8333-333333333333',
    revision: 1,
    sourceCommit: null,
    sourceBranch: null,
    capturedAt: 1,
    size: null,
    setupDurationMs: 1,
    stale: null,
    expiresAt: 2,
  };

  it('waits, then reads an unsupported provider before any build', () => {
    expect(buildSummaryLabel(undefined, t)).toBe('common.loading');
    expect(buildSummaryLabel(status({ supported: false }), t)).toBe(
      'agentChat.environment.buildUnavailableShort'
    );
  });

  it('prefers the running build over the last one', () => {
    expect(
      buildSummaryLabel(
        status({ activeBuild: build({ state: 'capturing' }), latestBuild: build() }),
        t
      )
    ).toBe('agentChat.environment.buildCapturing');
  });

  it('reads how the last build ended before how the snapshot stands', () => {
    expect(
      buildSummaryLabel(
        status({ latestBuild: build({ state: 'failed' }), published: published }),
        t
      )
    ).toBe('common.failed');
    expect(buildSummaryLabel(status({ published }), t)).toBe(
      'agentChat.environment.buildSucceeded'
    );
    expect(buildSummaryLabel(status({ published: { ...published, stale: 'revision' } }), t)).toBe(
      'agentChat.environment.buildStale'
    );
  });

  it('says so when nothing was built', () => {
    expect(buildSummaryLabel(status(), t)).toBe('agentChat.environment.buildNotBuilt');
  });
});

describe('environmentBuildAction', () => {
  it('offers no control to a reader who cannot manage the environment', () => {
    expect(environmentBuildAction(status(), { canManage: false }, t)).toEqual({
      kind: 'none',
      message: 'agentChat.environment.onlyManagersCanBuild',
    });
  });

  it('refuses a provider that cannot build and a build that is still stopping', () => {
    expect(environmentBuildAction(status({ supported: false }), { canManage: true }, t)).toEqual({
      kind: 'none',
      message: 'agentChat.environment.buildsUnavailable',
    });
    expect(
      environmentBuildAction(
        status({ activeBuild: build({ state: 'stopping' }) }),
        { canManage: true },
        t
      )
    ).toEqual({ kind: 'none', message: 'agentChat.environment.waitForBuilder' });
  });

  it('cancels a running build, refreshes a published one and builds the first', () => {
    const active = build({ state: 'capturing' });
    expect(environmentBuildAction(status({ activeBuild: active }), { canManage: true }, t)).toEqual(
      { kind: 'cancel', buildId: active.buildId }
    );
    expect(
      environmentBuildAction(
        status({
          published: {
            buildId: '33333333-3333-4333-8333-333333333333',
            revision: 1,
            sourceCommit: null,
            sourceBranch: null,
            capturedAt: 1,
            size: null,
            setupDurationMs: 1,
            stale: null,
            expiresAt: 2,
          },
        }),
        { canManage: true },
        t
      )
    ).toEqual({ kind: 'refresh' });
    expect(environmentBuildAction(status(), { canManage: true }, t)).toEqual({ kind: 'build' });
    expect(environmentBuildAction(undefined, { canManage: true }, t)).toEqual({
      kind: 'none',
      message: 'common.loading',
    });
  });
});

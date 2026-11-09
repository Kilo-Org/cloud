import { describe, expect, it } from 'vitest';
import type { SnapshotResolution } from '../../environment-build/coordinator.js';
import type { SessionEnvironmentReference } from '../../environment-build/reference.js';
import {
  environmentLaunchCandidate,
  environmentSnapshotDecision,
  environmentSnapshotStartBlock,
  environmentStartDetail,
  lookupEnvironmentSnapshot,
  snapshotStart,
} from './environment-snapshot-launch.js';
import type { RouteRecord } from './routes.js';

const REFERENCE: SessionEnvironmentReference = {
  environmentId: '11111111-1111-4111-8111-111111111111',
  owner: { type: 'user', id: 'user-1' },
  configurationRevision: 2,
  repository: { platform: 'github', repoFullName: 'acme/widgets' },
};

function route(overrides: Partial<RouteRecord> = {}): RouteRecord {
  const sessionId = overrides.sessionId ?? 'workspace_1';
  return {
    sessionId,
    spec: { sessionId, kiloSessionId: 'ses_1', directory: '/workspace/app', attemptId: 'a1' },
    grant: null,
    credentialSource: {
      userId: 'user-1',
      kiloSessionId: 'ses_1',
      kiloToken: 'token',
    },
    environment: REFERENCE,
    state: 'preparing',
    attemptId: 'a1',
    attemptDeadlineAt: 0,
    reason: null,
    ...overrides,
  };
}

const BUILD_ID = '33333333-3333-4333-8333-333333333333';

const RESOLVED: SnapshotResolution = {
  snapshot: {
    snapshotId: 'snap-1',
    baseImage: 'registry.example/app:1',
    revision: 1,
    capturedAt: Date.parse('2026-10-24T21:32:19Z'),
    buildId: '22222222-2222-4222-8222-222222222222',
    stale: 'revision',
  },
  reason: 'eligible',
  admission: { status: 'admitted', buildId: BUILD_ID },
  currentBaseImage: 'registry.example/app:1',
  build: {
    buildId: BUILD_ID,
    state: 'queued',
    outcome: null,
    failureReason: null,
  },
};

const CANDIDATE = {
  reference: REFERENCE,
  actorUserId: 'user-1',
  buildCommands: 0,
};

describe('environmentLaunchCandidate', () => {
  it('selects the one environment of the isolated preparing route', () => {
    expect(environmentLaunchCandidate([route()])).toEqual({
      candidate: { reference: REFERENCE, actorUserId: 'user-1', buildCommands: 0 },
    });
  });

  it('carries the largest build command count of the preparing routes', () => {
    expect(
      environmentLaunchCandidate([
        route(),
        route({
          sessionId: 'workspace_2',
          spec: { ...route().spec, environmentSetupCommandCount: 2 },
        }),
      ])
    ).toEqual({
      candidate: { reference: REFERENCE, actorUserId: 'user-1', buildCommands: 2 },
    });
  });

  it('starts from the image for shared paths, other environments or no environment', () => {
    expect(
      environmentLaunchCandidate([
        route({ spec: { ...route().spec, directory: '/workspace/user/worktree' } }),
      ])
    ).toEqual({ reason: 'not_isolated' });
    expect(environmentLaunchCandidate([route({ environment: null })])).toEqual({
      reason: 'no_environment',
    });
    expect(
      environmentLaunchCandidate([
        route(),
        route({
          sessionId: 'workspace_2',
          environment: { ...REFERENCE, configurationRevision: 3 },
        }),
      ])
    ).toEqual({ reason: 'multiple_environments' });
    expect(environmentLaunchCandidate([route({ state: 'ready' })])).toEqual({
      reason: 'no_preparing_routes',
    });
  });
});

describe('environmentLaunchCandidate for a V2 environment', () => {
  const member = (repoFullName: string) => ({
    identity: { platform: 'github' as const, repoFullName },
    repoFullName,
    leaf: repoFullName.slice(repoFullName.indexOf('/') + 1),
    branch: 'kilo/session',
  });
  const v2 = (...names: string[]): SessionEnvironmentReference => ({
    environmentId: REFERENCE.environmentId,
    owner: REFERENCE.owner,
    configurationRevision: 2,
    repositories: names.map(member),
  });
  const routeAt = (directory: string, environment: SessionEnvironmentReference) =>
    route({ spec: { ...route().spec, directory }, environment });

  it.each([
    ['one repository', '/workspace/widgets', ['acme/widgets']],
    ['several repositories', '/workspace', ['acme/widgets', 'acme/gadgets']],
  ])('expects the route at the cwd of %s', (_label, directory, names) => {
    const environment = v2(...names);
    expect(environmentLaunchCandidate([routeAt(directory, environment)])).toEqual({
      candidate: { reference: environment, actorUserId: 'user-1', buildCommands: 0 },
    });
  });

  it.each([
    ['revision', { configurationRevision: 3 }],
    ['environment', { environmentId: '0bd1c8b6-0e6c-4b0e-9d6a-8d5f0f5f4b11' }],
    ['owner', { owner: { type: 'user' as const, id: 'user-2' } }],
  ])('does not share a snapshot between V2 routes that differ by %s', (_label, change) => {
    const environment = v2('acme/widgets', 'acme/gadgets');
    expect(
      environmentLaunchCandidate([
        routeAt('/workspace', environment),
        { ...routeAt('/workspace', { ...environment, ...change }), sessionId: 'workspace_2' },
      ])
    ).toEqual({ reason: 'multiple_environments' });
  });

  it('starts from the image for a V2 route that is not at its layout cwd', () => {
    expect(environmentLaunchCandidate([routeAt('/workspace/app', v2('acme/widgets'))])).toEqual({
      reason: 'not_isolated',
    });
    expect(
      environmentLaunchCandidate([routeAt('/workspace/app', v2('acme/widgets', 'acme/gadgets'))])
    ).toEqual({ reason: 'not_isolated' });
  });
});

describe('environment snapshot lookup', () => {
  it('returns the coordinator resolution within the budget', async () => {
    const namespace = {
      getByName: () => ({ resolveSnapshot: async () => RESOLVED }),
    } as unknown as DurableObjectNamespace<never>;
    const lookup = await lookupEnvironmentSnapshot({
      namespace: namespace as never,
      candidate: { reference: REFERENCE, actorUserId: 'user-1', buildCommands: 0 },
      launchDeadlineAt: Date.now() + 60_000,
    });
    expect(lookup).toEqual({ kind: 'resolved', resolution: RESOLVED });
    expect(snapshotStart(RESOLVED)).toEqual({
      snapshotId: 'snap-1',
      baseImage: 'registry.example/app:1',
    });
  });

  it('times out at the launch deadline instead of waiting for the coordinator', async () => {
    const namespace = {
      getByName: () => ({ resolveSnapshot: () => new Promise(() => undefined) }),
    };
    const started = Date.now();
    const lookup = await lookupEnvironmentSnapshot({
      namespace: namespace as never,
      candidate: { reference: REFERENCE, actorUserId: 'user-1', buildCommands: 0 },
      launchDeadlineAt: Date.now() + 50,
    });
    expect(lookup).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('retries one transient failure and then reports it unavailable', async () => {
    let calls = 0;
    const namespace = {
      getByName: () => ({
        resolveSnapshot: async () => {
          calls += 1;
          throw new Error('transient');
        },
      }),
    };
    await expect(
      lookupEnvironmentSnapshot({
        namespace: namespace as never,
        candidate: { reference: REFERENCE, actorUserId: 'user-1', buildCommands: 0 },
        launchDeadlineAt: Date.now() + 60_000,
      })
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(calls).toBe(2);
    await expect(
      lookupEnvironmentSnapshot({
        namespace: undefined,
        candidate: { reference: REFERENCE, actorUserId: 'user-1', buildCommands: 0 },
        launchDeadlineAt: Date.now() + 60_000,
      })
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  it('uses the short snapshot label when configuration revisions match', () => {
    expect(
      environmentStartDetail(
        { ...REFERENCE, configurationRevision: 1 },
        {
          kind: 'resolved',
          resolution: { ...RESOLVED, admission: { status: 'not_needed' } },
        }
      )
    ).toBe('Using environment snapshot');
  });

  it('keeps changed settings and replacement build warnings without formatting dates', () => {
    expect(environmentStartDetail(REFERENCE, { kind: 'resolved', resolution: RESOLVED })).toBe(
      'Using environment snapshot; environment settings have changed; cached files may retain earlier values; a replacement build was started'
    );
    expect(
      environmentStartDetail(REFERENCE, {
        kind: 'resolved',
        resolution: {
          snapshot: null,
          reason: 'missing',
          admission: { status: 'skipped', reason: 'backoff', retryAt: 5 },
        },
      })
    ).toBe(
      'Starting without an environment snapshot; the replacement build is waiting after earlier failures'
    );
    expect(environmentStartDetail(REFERENCE, { kind: 'timeout' })).toBe(
      'Starting without an environment snapshot (lookup unavailable)'
    );
  });
});

describe('environmentSnapshotDecision', () => {
  it('starts an environment without build commands from the image when no snapshot exists', () => {
    expect(
      environmentSnapshotDecision(CANDIDATE, {
        kind: 'resolved',
        resolution: {
          snapshot: null,
          reason: 'missing',
          admission: { status: 'skipped', reason: 'unsupported' },
          build: null,
        },
      })
    ).toEqual({
      kind: 'start',
      snapshot: undefined,
      detail: 'Starting without an environment snapshot; no replacement build started',
    });
  });

  it('requires the published snapshot when the environment has build commands', () => {
    const candidate = { ...CANDIDATE, buildCommands: 2 };
    expect(
      environmentSnapshotDecision(candidate, { kind: 'resolved', resolution: RESOLVED })
    ).toEqual({
      kind: 'start',
      snapshot: { snapshotId: 'snap-1', baseImage: 'registry.example/app:1' },
      detail: expect.stringContaining('Using environment snapshot'),
    });
  });

  it('blocks with the building reason and the build to open', () => {
    const candidate = { ...CANDIDATE, buildCommands: 1 };
    const decision = environmentSnapshotDecision(candidate, {
      kind: 'resolved',
      resolution: {
        snapshot: null,
        reason: 'missing',
        admission: { status: 'admitted', buildId: BUILD_ID },
        build: { buildId: BUILD_ID, state: 'queued', outcome: null, failureReason: null },
      },
    });
    expect(decision).toEqual({
      kind: 'blocked',
      block: {
        reason: 'environment_building',
        detail: `The environment is building. Build ${BUILD_ID}.`,
        environmentId: REFERENCE.environmentId,
        buildId: BUILD_ID,
      },
    });
  });

  it('blocks with the failed reason after a failed automatic build', () => {
    const candidate = { ...CANDIDATE, buildCommands: 1 };
    expect(
      environmentSnapshotDecision(candidate, {
        kind: 'resolved',
        resolution: {
          snapshot: null,
          reason: 'missing',
          admission: { status: 'skipped', reason: 'backoff', retryAt: 5 },
          build: {
            buildId: BUILD_ID,
            state: 'failed',
            outcome: 'failed',
            failureReason: 'setup_failed',
          },
        },
      })
    ).toMatchObject({
      kind: 'blocked',
      block: {
        reason: 'environment_build_failed',
        environmentId: REFERENCE.environmentId,
        buildId: BUILD_ID,
      },
    });
  });

  it('reports the active build when backoff is waiting for it', () => {
    expect(
      environmentSnapshotDecision(
        { ...CANDIDATE, buildCommands: 1 },
        {
          kind: 'resolved',
          resolution: {
            snapshot: null,
            reason: 'missing',
            admission: { status: 'skipped', reason: 'backoff', retryAt: 5 },
            build: {
              buildId: BUILD_ID,
              state: 'preparing',
              outcome: null,
              failureReason: null,
            },
          },
        }
      )
    ).toMatchObject({
      kind: 'blocked',
      block: { reason: 'environment_building', buildId: BUILD_ID },
    });
  });

  it('blocks an unavailable lookup when the environment has build commands', () => {
    const candidate = { ...CANDIDATE, buildCommands: 1 };
    expect(environmentSnapshotDecision(candidate, { kind: 'timeout' })).toEqual({
      kind: 'blocked',
      block: {
        reason: 'environment_lookup_timeout',
        detail:
          'The environment snapshot lookup timed out. The environment must be built before this session can start.',
        environmentId: REFERENCE.environmentId,
        buildId: null,
      },
    });
    expect(environmentSnapshotDecision(candidate, { kind: 'unavailable' })).toMatchObject({
      kind: 'blocked',
      block: { reason: 'environment_lookup_unavailable', buildId: null },
    });
  });

  it('uses the current image identity for a previous-image snapshot inside the rollout window', () => {
    const resolution: SnapshotResolution = {
      ...RESOLVED,
      snapshot: {
        ...RESOLVED.snapshot!,
        baseImage: 'registry.example/app:previous',
        stale: 'image',
      },
      currentBaseImage: 'registry.example/app:2',
      admission: { status: 'admitted', buildId: BUILD_ID },
    };
    expect(snapshotStart(resolution)).toEqual({
      snapshotId: 'snap-1',
      baseImage: 'registry.example/app:2',
    });
    expect(environmentStartDetail(REFERENCE, { kind: 'resolved', resolution })).toContain(
      'built for an earlier image; using it during the rollout window'
    );
  });

  it('names the rebuild action after a required snapshot start fails', () => {
    expect(environmentSnapshotStartBlock({ ...CANDIDATE, buildCommands: 1 }, BUILD_ID)).toEqual({
      reason: 'environment_snapshot_start_failed',
      detail: `The environment snapshot could not start. Rebuild the environment. Build ${BUILD_ID}.`,
      environmentId: REFERENCE.environmentId,
      buildId: BUILD_ID,
    });
  });
});

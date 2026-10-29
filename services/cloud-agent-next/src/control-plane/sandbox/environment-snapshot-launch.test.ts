import { describe, expect, it } from 'vitest';
import type { SnapshotResolution } from '../../environment-build/coordinator.js';
import type { SessionEnvironmentReference } from '../../environment-build/reference.js';
import {
  environmentLaunchCandidate,
  environmentStartDetail,
  lookupEnvironmentSnapshot,
  previousSnapshotStartFailed,
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

const RESOLVED: SnapshotResolution = {
  snapshot: {
    snapshotId: 'snap-1',
    baseImage: 'registry.example/app:1',
    provider: 'cloudflare-containers',
    revision: 1,
    capturedAt: Date.parse('2026-10-24T21:32:19Z'),
    buildId: '22222222-2222-4222-8222-222222222222',
    stale: 'revision',
  },
  reason: 'eligible',
  admission: { status: 'admitted', buildId: '33333333-3333-4333-8333-333333333333' },
};

describe('environmentLaunchCandidate', () => {
  it('selects the one environment of the isolated preparing route', () => {
    expect(environmentLaunchCandidate([route()])).toEqual({
      candidate: { reference: REFERENCE, actorUserId: 'user-1' },
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

describe('previousSnapshotStartFailed', () => {
  it('starts fresh once after a snapshot start that never connected or failed preparation', () => {
    expect(previousSnapshotStartFailed(undefined)).toBe(false);
    expect(
      previousSnapshotStartFailed({
        allocationId: 'a',
        startSource: 'repository',
        confirmed: false,
      })
    ).toBe(true);
    expect(
      previousSnapshotStartFailed({
        allocationId: 'a',
        startSource: 'repository',
        confirmed: true,
        preparationFailures: [{ sessionId: 's', attemptId: 'a1' }],
      })
    ).toBe(true);
    expect(
      previousSnapshotStartFailed({ allocationId: 'a', startSource: 'image', confirmed: true })
    ).toBe(false);
    expect(
      previousSnapshotStartFailed({ allocationId: 'a', skipRepository: true, confirmed: false })
    ).toBe(true);
  });
});

describe('environment snapshot lookup', () => {
  it('returns the coordinator resolution within the budget', async () => {
    const namespace = {
      getByName: () => ({ resolveSnapshot: async () => RESOLVED }),
    } as unknown as DurableObjectNamespace<never>;
    const lookup = await lookupEnvironmentSnapshot({
      namespace: namespace as never,
      candidate: { reference: REFERENCE, actorUserId: 'user-1' },
      launchDeadlineAt: Date.now() + 60_000,
    });
    expect(lookup).toEqual({ kind: 'resolved', resolution: RESOLVED });
    expect(snapshotStart(RESOLVED)).toEqual({
      snapshotId: 'snap-1',
      baseImage: 'registry.example/app:1',
      provider: 'cloudflare-containers',
    });
  });

  it('times out at the launch deadline instead of waiting for the coordinator', async () => {
    const namespace = {
      getByName: () => ({ resolveSnapshot: () => new Promise(() => undefined) }),
    };
    const started = Date.now();
    const lookup = await lookupEnvironmentSnapshot({
      namespace: namespace as never,
      candidate: { reference: REFERENCE, actorUserId: 'user-1' },
      launchDeadlineAt: Date.now() + 50,
    });
    expect(lookup).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('retries one transient failure and then starts without a snapshot', async () => {
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
        candidate: { reference: REFERENCE, actorUserId: 'user-1' },
        launchDeadlineAt: Date.now() + 60_000,
      })
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(calls).toBe(2);
    await expect(
      lookupEnvironmentSnapshot({
        namespace: undefined,
        candidate: { reference: REFERENCE, actorUserId: 'user-1' },
        launchDeadlineAt: Date.now() + 60_000,
      })
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  it('uses the same snapshot name when configuration revisions match', () => {
    expect(
      environmentStartDetail(
        { ...REFERENCE, configurationRevision: 1 },
        {
          kind: 'resolved',
          resolution: { ...RESOLVED, admission: { status: 'not_needed' } },
        }
      )
    ).toBe('Using snapshot · 24 Oct 2026, 21:32:19 UTC');
  });

  it('names the snapshot by capture time and explains changed settings', () => {
    expect(environmentStartDetail(REFERENCE, { kind: 'resolved', resolution: RESOLVED })).toBe(
      'Using snapshot · 24 Oct 2026, 21:32:19 UTC; environment settings have changed; cached files may retain earlier values; a replacement build was started'
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

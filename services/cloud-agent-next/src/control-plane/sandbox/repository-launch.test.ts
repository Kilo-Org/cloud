import { describe, expect, it } from 'vitest';
import { repositoryLaunchOptions, type RepositoryLaunchRecord } from './repository-launch.js';
import type { RouteRecord } from './routes.js';

function preparingRoute(
  overrides: Partial<Pick<RouteRecord, 'state' | 'repoKey' | 'sessionId'>> = {}
): RouteRecord {
  const sessionId = overrides.sessionId ?? 'workspace_1';
  return {
    sessionId,
    spec: {
      sessionId,
      kiloSessionId: 'ses_1',
      directory: '/workspace/app',
      attemptId: 'attempt_1',
    },
    grant: null,
    credentialSource: null,
    repoKey: 'repo-key',
    state: 'preparing',
    attemptId: 'attempt_1',
    attemptDeadlineAt: 0,
    reason: null,
    ...overrides,
  };
}

describe('repositoryLaunchOptions', () => {
  it('reports no_preparing_routes when no route is waiting', () => {
    const decision = repositoryLaunchOptions([preparingRoute({ state: 'ready' })], undefined);
    expect(decision).toEqual({
      options: {},
      reason: 'no_preparing_routes',
      preparingRouteCount: 0,
      distinctKeyCount: 0,
      discarded: false,
    });
  });

  it('reports no_repo_key when the waiting route has no key', () => {
    const decision = repositoryLaunchOptions([preparingRoute({ repoKey: null })], undefined);
    expect(decision.reason).toBe('no_repo_key');
    expect(decision.distinctKeyCount).toBe(1);
    expect(decision.options).toEqual({});
  });

  it('reports multiple_keys when waiting routes disagree', () => {
    const decision = repositoryLaunchOptions(
      [
        preparingRoute({ repoKey: 'a' }),
        preparingRoute({ sessionId: 'workspace_2', repoKey: 'b' }),
      ],
      undefined
    );
    expect(decision.reason).toBe('multiple_keys');
    expect(decision.distinctKeyCount).toBe(2);
    expect(decision.options).toEqual({});
  });

  it('chooses the one shared key', () => {
    const decision = repositoryLaunchOptions(
      [
        preparingRoute({ repoKey: 'shared' }),
        preparingRoute({ sessionId: 'workspace_2', repoKey: 'shared' }),
      ],
      undefined
    );
    expect(decision.reason).toBe('repository');
    expect(decision.options).toEqual({ repoKey: 'shared' });
    expect(decision.discarded).toBe(false);
  });

  it('discards a previous repository start whose wrapper never connected', () => {
    const previous: RepositoryLaunchRecord = {
      allocationId: 'allocation_1',
      startSource: 'repository',
      confirmed: false,
    };
    const decision = repositoryLaunchOptions([preparingRoute()], previous);
    expect(decision.discarded).toBe(true);
    expect(decision.options).toEqual({ repoKey: 'repo-key', discardRepository: true });
  });

  it('keeps a confirmed repository start', () => {
    const previous: RepositoryLaunchRecord = {
      allocationId: 'allocation_1',
      startSource: 'repository',
      confirmed: true,
    };
    const decision = repositoryLaunchOptions([preparingRoute()], previous);
    expect(decision.discarded).toBe(false);
    expect(decision.options).toEqual({ repoKey: 'repo-key' });
  });
});

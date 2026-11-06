import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_RENEWAL_RETRY_MS,
  createCredentialRenewalCoordinator,
  decideRenewalTargetVerdict,
  type CredentialRenewalTarget,
  type RenewalRouteSnapshot,
} from './credential-renewal.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

const fence = {
  allocationId: 'alloc_1',
  connectionId: 'conn_1',
  providerInstanceId: 'provider_1',
  wrapperInstanceId: 'wrapper_1',
};

function target(overrides: Partial<CredentialRenewalTarget> = {}): CredentialRenewalTarget {
  return {
    sessionId: 'session_a',
    scopeKey: 'scope_1:runtime',
    scopeGrantJson: '{"members":["a","b"]}',
    ...fence,
    attemptId: 'attempt_1',
    grantExpiresAt: 1_000,
    ...overrides,
  };
}

function route(overrides: Partial<RenewalRouteSnapshot> = {}): RenewalRouteSnapshot {
  return {
    sessionId: 'session_a',
    scopeKey: 'scope_1:runtime',
    scopeGrantJson: '{"members":["a","b"]}',
    attemptId: 'attempt_1',
    grantExpiresAt: 1_000,
    hasCredentialSource: true,
    ...overrides,
  };
}

describe('decideRenewalTargetVerdict', () => {
  it('admits a captured target that is still current', () => {
    expect(
      decideRenewalTargetVerdict({
        target: target(),
        route: {
          scopeKey: 'scope_1:runtime',
          grantExpiresAt: 1_000,
          state: 'ready',
          attemptId: 'attempt_1',
        },
        authoritativeScopeGrantJson: '{"members":["a","b"]}',
        fence,
      })
    ).toBe('current');
  });

  it('reports a released route', () => {
    expect(
      decideRenewalTargetVerdict({
        target: target(),
        route: null,
        authoritativeScopeGrantJson: null,
        fence,
      })
    ).toBe('released');
  });

  const replacedRoutes: Array<
    [string, { scopeKey?: string; grantExpiresAt?: number; state?: string; attemptId?: string }]
  > = [
    ['scope', { scopeKey: 'other:runtime' }],
    ['expiry', { grantExpiresAt: 2_000 }],
    ['attempt', { attemptId: 'attempt_2' }],
    ['attempt state', { state: 'failed' }],
  ];
  it.each(replacedRoutes)('reports a replaced route when the %s moved', (_label, moved) => {
    expect(
      decideRenewalTargetVerdict({
        target: target(),
        route: {
          scopeKey: 'scope_1:runtime',
          grantExpiresAt: 1_000,
          state: 'ready',
          attemptId: 'attempt_1',
          ...moved,
        },
        authoritativeScopeGrantJson: '{"members":["a","b"]}',
        fence,
      })
    ).toBe('replaced');
  });

  it('reports stale when the canonical membership changed during the mint', () => {
    expect(
      decideRenewalTargetVerdict({
        target: target(),
        route: {
          scopeKey: 'scope_1:runtime',
          grantExpiresAt: 1_000,
          state: 'ready',
          attemptId: 'attempt_1',
        },
        authoritativeScopeGrantJson: '{"members":["a"]}',
        fence,
      })
    ).toBe('stale');
  });

  it('reports stale when the captured physical allocation changed', () => {
    expect(
      decideRenewalTargetVerdict({
        target: target(),
        route: {
          scopeKey: 'scope_1:runtime',
          grantExpiresAt: 1_000,
          state: 'ready',
          attemptId: 'attempt_1',
        },
        authoritativeScopeGrantJson: '{"members":["a","b"]}',
        fence: { ...fence, connectionId: 'conn_2' },
      })
    ).toBe('stale');
  });
});

describe('CredentialRenewalCoordinator', () => {
  it('tracks one flight and clears it when the work settles', async () => {
    const coordinator = createCredentialRenewalCoordinator();
    const gate = deferred();
    let settled = 0;
    const flight = coordinator.track(
      () => gate.promise,
      () => {
        settled += 1;
      }
    );
    expect(flight).not.toBeNull();
    if (flight === null) throw new Error('expected a tracked flight');
    expect(coordinator.inFlight).toBe(true);
    expect(
      coordinator.track(
        async () => undefined,
        () => undefined
      )
    ).toBeNull();
    gate.resolve();
    await flight;
    expect(coordinator.inFlight).toBe(false);
    expect(settled).toBe(1);
  });

  it('selects one target per due scope and reserves a retry before yielding', () => {
    const coordinator = createCredentialRenewalCoordinator();
    const now = 10_000;
    const targets = coordinator.selectTargets({
      routes: [
        route({ sessionId: 'a', grantExpiresAt: now + 10 }),
        route({ sessionId: 'b', grantExpiresAt: now + 20 }),
        route({ sessionId: 'c', scopeKey: 'other:runtime', grantExpiresAt: now + 60 * 60_000 }),
      ],
      fence,
      now,
      reissueBelowMs: 60_000,
    });
    expect(targets.map(t => t.sessionId)).toEqual(['a']);
    expect(coordinator.retryAt('scope_1:runtime')).toBe(
      Math.min(now + CREDENTIAL_RENEWAL_RETRY_MS, now + 10)
    );
  });

  it('does not select a target while its retry backoff is open', () => {
    const coordinator = createCredentialRenewalCoordinator();
    const now = 10_000;
    coordinator.reserveRetry('scope_1:runtime', now, now + 60 * 60_000);
    expect(
      coordinator.selectTargets({
        routes: [route({ grantExpiresAt: now + 10 })],
        fence,
        now,
        reissueBelowMs: 60_000,
      })
    ).toEqual([]);
    expect(
      coordinator.selectTargets({
        routes: [route({ grantExpiresAt: now + 10 })],
        fence,
        now: now + CREDENTIAL_RENEWAL_RETRY_MS + 1,
        reissueBelowMs: 60_000,
      })
    ).toHaveLength(1);
  });

  it('resolves an already-expired grant to now and defers a retrying scope', () => {
    const coordinator = createCredentialRenewalCoordinator();
    const now = 10_000;
    expect(
      coordinator.nextDeadline({
        routes: [route({ grantExpiresAt: now - 1 })],
        now,
        reissueBelowMs: 60_000,
        canRenew: true,
      })
    ).toBe(now + 1);

    coordinator.reserveRetry('scope_1:runtime', now, now + 60 * 60_000);
    expect(
      coordinator.nextDeadline({
        routes: [route({ grantExpiresAt: now + 20 * 60_000 })],
        now,
        reissueBelowMs: 60 * 60_000,
        canRenew: true,
      })
    ).toBe(now + CREDENTIAL_RENEWAL_RETRY_MS);
  });

  it('prunes retry state for scopes that are no longer ready', () => {
    const coordinator = createCredentialRenewalCoordinator();
    coordinator.reserveRetry('gone:runtime', 10_000, 20_000);
    coordinator.nextDeadline({
      routes: [route()],
      now: 10_000,
      reissueBelowMs: 60_000,
      canRenew: true,
    });
    expect(coordinator.retryAt('gone:runtime')).toBeUndefined();
  });
});

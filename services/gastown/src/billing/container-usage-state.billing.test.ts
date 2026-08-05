import { describe, expect, it } from 'vitest';
import {
  createPendingStop,
  isRuntimeStoppedStatus,
  BILLING_STATE_VERSION,
  migrateStoredUsageState,
  toBillingStatus,
  type OpenUsageInterval,
  type StoredUsageState,
} from './container-usage-state.billing';
import type { UsageContext } from './container-usage.billing';

const context: UsageContext = {
  service: 'gastown',
  instanceId: 'container-1',
  sku: 'gastown-standard-2026-07',
  subject: { type: 'org', id: 'org-1' },
  actor: { type: 'user', id: 'user-1' },
  sessionId: 'town-1',
  metadata: { townId: 'town-1' },
};

describe('toBillingStatus', () => {
  it('hides persisted state while billing is disabled', () => {
    expect(
      toBillingStatus(false, {
        phase: 'idle',
        context,
        blocked: true,
        latestBudget: { verdict: 'stop', remaining: 0 },
      })
    ).toEqual({ enabled: false, enforcing: false, state: 'idle', runPolicy: 'automatic' });
  });

  it('reports metering without enforcement by default', () => {
    const status = toBillingStatus(true, { phase: 'idle', context });
    expect(status.enabled).toBe(true);
    expect(status.enforcing).toBe(false);
  });

  it('reflects the enforcing flag when passed', () => {
    const status = toBillingStatus(true, { phase: 'idle', context }, 'automatic', Date.now(), true);
    expect(status.enabled).toBe(true);
    expect(status.enforcing).toBe(true);
  });

  it('returns a payer-aware blocked state', () => {
    expect(
      toBillingStatus(true, {
        phase: 'idle',
        context,
        blocked: true,
        latestBudget: { verdict: 'stop', remaining: 0.25 },
      })
    ).toEqual({
      enabled: true,
      enforcing: false,
      state: 'blocked',
      runPolicy: 'automatic',
      payer: { type: 'org', id: 'org-1' },
      remaining: 0.25,
    });
  });

  it.each([
    ['continue', 'running'],
    ['warn', 'warning'],
    ['stop', 'stopping'],
  ] as const)('maps %s budget verdicts to %s', (verdict, expectedState) => {
    const state: StoredUsageState = {
      phase: 'running',
      context,
      startEpochMs: 1_000,
      startRecorded: true,
      seq: 2,
      lastReportedAt: 2_000,
      latestBudget: { verdict, remaining: 4 },
      minimumRequired: 1,
      estimatedHourlyCharge: 1.2,
      reportedUsageSeconds: 900,
    };

    expect(toBillingStatus(true, state, 'automatic', 2_000)).toMatchObject({
      enabled: true,
      state: expectedState,
      runPolicy: 'automatic',
      payer: context.subject,
      remaining: 4,
      minimumRequired: 1,
      estimatedHourlyCharge: 1.2,
      intervalStartedAt: 1_000,
      lastReportedAt: 2_000,
      runUsageSeconds: 900,
      estimatedRunCharge: 0.3,
    });
  });

  it('reports a user pause separately from a credit block', () => {
    expect(
      toBillingStatus(
        true,
        {
          phase: 'idle',
          context,
          blocked: false,
          lastRun: {
            startedAt: 1_000,
            stoppedAt: 2_000,
            usageSeconds: 900,
            estimatedCharge: 0.3,
          },
        },
        'paused_by_user',
        2_000
      )
    ).toMatchObject({
      enabled: true,
      state: 'paused',
      runPolicy: 'paused_by_user',
      payer: context.subject,
      estimatedRunCharge: 0.3,
      runUsageSeconds: 900,
    });
  });
});

describe('locally force-closed interval', () => {
  it('returns to a non-blocked idle state after unsettled shutdown', () => {
    const status = toBillingStatus(
      true,
      {
        version: BILLING_STATE_VERSION,
        phase: 'idle',
        context,
        lastRun: {
          startedAt: 1_000,
          stoppedAt: 5_000,
          usageSeconds: 4,
          estimatedCharge: 0.02,
          unsettled: true,
        },
      },
      'automatic'
    );

    expect(status.state).toBe('idle');
    expect(status.estimatedRunCharge).toBeCloseTo(0.02, 6);
  });
});

describe('isRuntimeStoppedStatus', () => {
  it('treats definitively stopped runtimes as stopped', () => {
    expect(isRuntimeStoppedStatus('stopped')).toBe(true);
    expect(isRuntimeStoppedStatus('stopped_with_code')).toBe(true);
  });

  it('treats live and transient boot/shutdown states as not stopped', () => {
    // A freshly created town briefly reports these before it is healthy;
    // treating any of them as stopped would immediately close the interval and
    // shut the new container down.
    for (const status of ['running', 'healthy', 'stopping', 'starting', 'scheduling', '']) {
      expect(isRuntimeStoppedStatus(status)).toBe(false);
    }
  });
});

describe('createPendingStop', () => {
  it('captures whole seconds remaining after the last acknowledged segment', () => {
    const state: OpenUsageInterval = {
      phase: 'stopping',
      context,
      startEpochMs: 1_000,
      startRecorded: true,
      seq: 2,
      lastReportedAt: 2_000,
      reportedUsageSeconds: 1,
    };

    expect(createPendingStop(state, 7_500, 'runtime_signal')).toEqual({
      seq: 3,
      usageSinceLast: 5,
      measuredAtMs: 7_000,
      reason: 'runtime_signal',
    });
  });
});

describe('migrateStoredUsageState', () => {
  it('resets hypothetical authorization state that predates the real meter', () => {
    const legacy = {
      phase: 'stopping',
      context,
      authorizationId: 'dev:old',
      authorizationKey: 'old-key',
      startEpochMs: 1_000,
      startRecorded: true,
      seq: 1,
      lastReportedAt: 2_000,
      latestBudget: { verdict: 'stop', remaining: 0 },
    } as StoredUsageState;

    expect(migrateStoredUsageState(legacy)).toEqual({
      version: BILLING_STATE_VERSION,
      phase: 'idle',
      context,
    });
  });

  it('preserves an unversioned real-meter interval', () => {
    const current: StoredUsageState = {
      phase: 'running',
      context,
      startEpochMs: 1_000,
      startRecorded: true,
      seq: 1,
      lastReportedAt: 2_000,
    };

    expect(migrateStoredUsageState(current)).toEqual({
      ...current,
      version: BILLING_STATE_VERSION,
    });
  });

  it('clears an unversioned stale credit block', () => {
    expect(
      migrateStoredUsageState({
        phase: 'idle',
        context,
        blocked: true,
        latestBudget: { verdict: 'stop', remaining: 0 },
      })
    ).toEqual({ version: BILLING_STATE_VERSION, phase: 'idle', context });
  });
});

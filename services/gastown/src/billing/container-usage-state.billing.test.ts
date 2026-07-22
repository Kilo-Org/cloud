import { describe, expect, it } from 'vitest';
import { toBillingStatus, type StoredUsageState } from './container-usage-state.billing';
import type { UsageContext } from './container-usage.billing';

const context: UsageContext = {
  service: 'gastown',
  instanceId: 'container-1',
  sku: 'cloudflare-container-standard-4',
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
    ).toEqual({ enabled: false, state: 'idle' });
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
      state: 'blocked',
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
      authorizationId: 'auth-1',
      authorizationKey: 'authorize-1',
      startEpochMs: 1_000,
      startRecorded: true,
      seq: 2,
      lastReportedAt: 2_000,
      latestBudget: { verdict, remaining: 4 },
      minimumRequired: 1,
      estimatedHourlyCharge: 1.2,
    };

    expect(toBillingStatus(true, state)).toMatchObject({
      enabled: true,
      state: expectedState,
      payer: context.subject,
      remaining: 4,
      minimumRequired: 1,
      estimatedHourlyCharge: 1.2,
      intervalStartedAt: 1_000,
      lastReportedAt: 2_000,
    });
  });
});

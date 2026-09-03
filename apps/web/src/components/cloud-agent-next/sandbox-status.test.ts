import { describe, expect, it } from '@jest/globals';
import type { CloudAgentSessionId, KiloSessionId } from '@kilocode/cloud-agent-sdk';
import type { SandboxStatusSnapshot } from '@/routers/cloud-agent-next-schemas';
import { isSandboxStatusEligible, sandboxStatusPresentation } from './sandbox-status';

const now = 1_800_000_000_000;
const snapshot: SandboxStatusSnapshot = {
  status: 'active',
  provider: 'Cloudflare',
  observedAt: now,
  detailCode: 'sandbox_ready',
  inactivityTimeoutMs: 300_000,
  estimatedSleepAt: now + 180_000,
};
const runtime = {
  sandboxType: 'isolated-standard',
  kiloCliVersion: '7.4.20',
  wrapperVersion: '2.4.0',
  startedAt: now - 600_000,
  stoppedAt: null,
} satisfies NonNullable<SandboxStatusSnapshot['runtime']>;
const observation = {
  data: snapshot,
  observation: 'observing' as const,
  dataUpdatedAt: now,
  freshAfter: now,
  estimateAfter: 0,
  sessionActive: false,
  now,
};

const sessionId = 'workspace_00000000-0000-4000-8000-000000000001' as CloudAgentSessionId;
const kiloSessionId = 'ses_status_first' as KiloSessionId;
const eligible = {
  currentUserId: 'owner',
  sessionId,
  sessionIdFromParams: kiloSessionId,
  activeSessionType: 'cloud-agent' as const,
  isReadOnly: false,
  fetchedSessionData: { kiloSessionId, cloudAgentSessionId: sessionId, organizationId: null },
};

describe('sandbox status eligibility', () => {
  it('requires a resolved owned workspace in the exact route scope', () => {
    expect(isSandboxStatusEligible(eligible)).toBe(true);
    expect(
      isSandboxStatusEligible({
        ...eligible,
        organizationId: 'org-1',
        fetchedSessionData: { ...eligible.fetchedSessionData, organizationId: 'org-1' },
      })
    ).toBe(true);
  });

  it.each([
    { currentUserId: undefined },
    { sessionId: null },
    { sessionId: 'Starting session…' },
    { sessionId: 'workspace_invalid' },
    { sessionId: 'agent_00000000-0000-4000-8000-000000000001' },
    { activeSessionType: null },
    { activeSessionType: 'remote' as const },
    { activeSessionType: 'read-only' as const },
    { isReadOnly: true },
    { fetchedSessionData: null },
    { sessionIdFromParams: 'ses_other' },
    { organizationId: 'org-other' },
    { fetchedSessionData: { ...eligible.fetchedSessionData, organizationId: 'org-other' } },
    { fetchedSessionData: { ...eligible.fetchedSessionData, cloudAgentSessionId: null } },
  ])('excludes unresolved, unrelated, and unsupported contexts: %j', override => {
    expect(isSandboxStatusEligible({ ...eligible, ...override })).toBe(false);
  });
});

describe('sandbox status presentation', () => {
  it.each([
    ['active', 'sandbox_ready', 'Active'],
    ['sleeping', 'sandbox_stopped', 'Sleeping'],
    ['starting', 'sandbox_starting', 'Starting'],
    ['stopping', 'sandbox_stopping', 'Stopping'],
    ['error', 'sandbox_failed', 'Error'],
    ['unreachable', 'connection_unavailable', 'Unreachable'],
    ['unknown', 'insufficient_evidence', 'Unknown'],
  ] as const)(
    'presents authoritative %s lifecycle without raw diagnostics',
    (status, detailCode, label) => {
      const view = sandboxStatusPresentation({
        ...observation,
        data: {
          ...snapshot,
          status,
          detailCode,
          estimatedSleepAt: null,
          privateRuntime: 'PRIVATE_SENTINEL',
        },
      });
      expect(view).toMatchObject({
        status,
        label,
        provider: 'Cloudflare',
        estimatedSleepAt: null,
        sleepMinutesRemaining: null,
      });
      expect(JSON.stringify(view)).not.toContain('PRIVATE_SENTINEL');
    }
  );

  it.each(['Cloudflare', 'Vercel', 'Unknown'] as const)(
    'uses the bounded %s provider',
    provider => {
      expect(
        sandboxStatusPresentation({ ...observation, data: { ...snapshot, provider } }).provider
      ).toBe(provider);
    }
  );

  it.each([
    [180_000, 1],
    [300_000, 3],
    [600_000, 8],
  ])(
    'reveals the estimate after two minutes using the returned %d ms policy',
    (inactivityTimeoutMs, sleepMinutesRemaining) => {
      const data = {
        ...snapshot,
        inactivityTimeoutMs,
        estimatedSleepAt: now + inactivityTimeoutMs - 120_000 + 1,
      };
      expect(sandboxStatusPresentation({ ...observation, data })).toMatchObject({
        estimatedSleepAt: null,
        sleepMinutesRemaining: null,
        nextChangeAt: now + 1,
      });
      expect(sandboxStatusPresentation({ ...observation, data, now: now + 1 })).toMatchObject({
        estimatedSleepAt: data.estimatedSleepAt,
        sleepMinutesRemaining,
      });
    }
  );

  it('hides timing for a new idle window and an unknown policy', () => {
    expect(
      sandboxStatusPresentation({
        ...observation,
        data: { ...snapshot, estimatedSleepAt: now + 300_000 },
      })
    ).toMatchObject({
      status: 'active',
      estimatedSleepAt: null,
      sleepMinutesRemaining: null,
      nextChangeAt: now + 15_000,
    });
    expect(
      sandboxStatusPresentation({
        ...observation,
        data: { ...snapshot, inactivityTimeoutMs: null, estimatedSleepAt: null },
      })
    ).toMatchObject({ status: 'active', estimatedSleepAt: null, sleepMinutesRemaining: null });
  });

  it.each([
    [180_000, 3],
    [120_001, 3],
    [120_000, 2],
    [119_999, 2],
    [60_001, 2],
    [60_000, 1],
    [59_999, 1],
    [1, 1],
  ])('rounds %d ms remaining up to %d minutes', (remainingMs, sleepMinutesRemaining) => {
    expect(
      sandboxStatusPresentation({
        ...observation,
        data: { ...snapshot, estimatedSleepAt: now + remainingMs },
      })
    ).toMatchObject({
      estimatedSleepAt: now + remainingMs,
      sleepMinutesRemaining,
    });
  });

  it('schedules countdown changes before freshness expires without new polling evidence', () => {
    const data = { ...snapshot, estimatedSleepAt: now + 121_000 };
    expect(sandboxStatusPresentation({ ...observation, data })).toMatchObject({
      status: 'active',
      sleepMinutesRemaining: 3,
      nextChangeAt: now + 1_000,
    });
    expect(sandboxStatusPresentation({ ...observation, data, now: now + 999 })).toMatchObject({
      sleepMinutesRemaining: 3,
      nextChangeAt: now + 1_000,
    });
    expect(sandboxStatusPresentation({ ...observation, data, now: now + 1_000 })).toMatchObject({
      status: 'active',
      estimatedSleepAt: data.estimatedSleepAt,
      sleepMinutesRemaining: 2,
      nextChangeAt: now + 15_000,
    });
  });

  it('expires freshness when it coincides with a countdown boundary', () => {
    const data = { ...snapshot, estimatedSleepAt: now + 135_000 };
    expect(sandboxStatusPresentation({ ...observation, data })).toMatchObject({
      status: 'active',
      sleepMinutesRemaining: 3,
      nextChangeAt: now + 15_000,
    });
    expect(sandboxStatusPresentation({ ...observation, data, now: now + 15_000 })).toMatchObject({
      status: 'unknown',
      estimatedSleepAt: null,
      sleepMinutesRemaining: null,
      nextChangeAt: null,
    });
  });

  it('uses unknown for initial loading without a separate loading state', () => {
    expect(sandboxStatusPresentation({ ...observation, observation: 'checking' })).toMatchObject({
      status: 'unknown',
      label: 'Unknown',
      kiloCliVersion: null,
      wrapperVersion: null,
      estimatedSleepAt: null,
      sleepMinutesRemaining: null,
    });
  });

  it('enters sleeping soon at the final-minute boundary', () => {
    const data = { ...snapshot, estimatedSleepAt: now + 60_001 };
    expect(sandboxStatusPresentation({ ...observation, data })).toMatchObject({
      status: 'active',
      sleepMinutesRemaining: 2,
      nextChangeAt: now + 1,
    });
    expect(sandboxStatusPresentation({ ...observation, data, now: now + 1 })).toMatchObject({
      status: 'sleeping-soon',
      label: 'Sleeping soon',
      estimatedSleepAt: now + 60_001,
      sleepMinutesRemaining: 1,
      nextChangeAt: now + 15_000,
    });
  });

  it('cancels sleeping soon when activity invalidates the deadline', () => {
    const data = { ...snapshot, estimatedSleepAt: now + 60_000 };
    for (const override of [{ sessionActive: true }, { estimateAfter: now + 1 }]) {
      expect(sandboxStatusPresentation({ ...observation, data, ...override })).toMatchObject({
        status: 'active',
        estimatedSleepAt: null,
        sleepMinutesRemaining: null,
        nextChangeAt: now + 15_000,
      });
    }
  });

  it('requires fresh idle evidence after activity before restoring the countdown', () => {
    const data = { ...snapshot, estimatedSleepAt: now + 121_000 };
    expect(sandboxStatusPresentation({ ...observation, data })).toMatchObject({
      sleepMinutesRemaining: 3,
      nextChangeAt: now + 1_000,
    });
    for (const override of [{ sessionActive: true }, { estimateAfter: now + 1 }]) {
      expect(sandboxStatusPresentation({ ...observation, data, ...override })).toMatchObject({
        estimatedSleepAt: null,
        sleepMinutesRemaining: null,
        nextChangeAt: now + 15_000,
      });
    }
    expect(
      sandboxStatusPresentation({
        ...observation,
        data: { ...data, observedAt: now + 1_000 },
        dataUpdatedAt: now + 1_000,
        estimateAfter: now + 1,
        now: now + 1_000,
      })
    ).toMatchObject({
      estimatedSleepAt: data.estimatedSleepAt,
      sleepMinutesRemaining: 2,
      nextChangeAt: now + 16_000,
    });
  });

  it.each(['paused', 'unavailable'] as const)(
    'suppresses all cached current evidence when %s',
    state => {
      expect(sandboxStatusPresentation({ ...observation, observation: state })).toMatchObject({
        status: 'unknown',
        provider: 'Unknown',
        kiloCliVersion: null,
        wrapperVersion: null,
        estimatedSleepAt: null,
        sleepMinutesRemaining: null,
        nextChangeAt: null,
      });
    }
  );

  it('distinguishes observation failure from confirmed sandbox failure', () => {
    const unavailable = sandboxStatusPresentation({ ...observation, observation: 'unavailable' });
    const failed = sandboxStatusPresentation({
      ...observation,
      data: { ...snapshot, status: 'error', detailCode: 'sandbox_failed', estimatedSleepAt: null },
    });
    expect(unavailable.detail).toContain('does not mean the sandbox failed');
    expect(failed.detail).toContain('encountered an error');
  });

  it.each([
    { now: now + 15_000 },
    { dataUpdatedAt: now - 15_000, freshAfter: 0 },
    { data: { ...snapshot, runtime, observedAt: now - 15_000 }, freshAfter: 0 },
    { freshAfter: now + 1 },
    { data: { ...snapshot, runtime, observedAt: now + 1 } },
  ])('bounds freshness and requires fresh evidence after resuming: %j', override => {
    expect(
      sandboxStatusPresentation({ ...observation, data: { ...snapshot, runtime }, ...override })
    ).toMatchObject({
      status: 'unknown',
      provider: 'Unknown',
      sandboxType: 'Unknown',
      kiloCliVersion: null,
      wrapperVersion: null,
      startedAt: null,
      stoppedAt: null,
      estimatedSleepAt: null,
      sleepMinutesRemaining: null,
      nextChangeAt: null,
    });
  });

  it('remains current before the 15-second boundary and schedules its expiry', () => {
    expect(
      sandboxStatusPresentation({
        ...observation,
        data: { ...snapshot, runtime },
        now: now + 14_999,
      })
    ).toMatchObject({
      status: 'active',
      kiloCliVersion: '7.4.20',
      wrapperVersion: '2.4.0',
      sleepMinutesRemaining: 3,
      nextChangeAt: now + 15_000,
    });
  });

  it.each([
    { sessionActive: true },
    { estimateAfter: now + 1 },
    { data: { ...snapshot, estimatedSleepAt: null } },
    { data: { ...snapshot, provider: 'Unknown' } },
  ])('hides unsupported or invalidated sleep estimates: %j', override => {
    expect(sandboxStatusPresentation({ ...observation, ...override })).toMatchObject({
      status: 'active',
      estimatedSleepAt: null,
      sleepMinutesRemaining: null,
    });
  });

  it('expires an estimate without inventing sleeping', () => {
    const data = { ...snapshot, estimatedSleepAt: now + 2_000 };
    expect(sandboxStatusPresentation({ ...observation, data })).toMatchObject({
      status: 'sleeping-soon',
      estimatedSleepAt: now + 2_000,
      sleepMinutesRemaining: 1,
      nextChangeAt: now + 2_000,
    });
    for (const elapsedMs of [2_000, 2_001]) {
      expect(
        sandboxStatusPresentation({ ...observation, data, now: now + elapsedMs })
      ).toMatchObject({
        status: 'active',
        estimatedSleepAt: null,
        sleepMinutesRemaining: null,
        nextChangeAt: now + 15_000,
      });
    }
  });

  it('exposes validated runtime versions without sandbox identities', () => {
    const view = sandboxStatusPresentation({
      ...observation,
      data: {
        ...snapshot,
        sandboxId: 'PRIVATE_SANDBOX_ID',
        runtime: { ...runtime, providerRef: 'PRIVATE_PROVIDER_REF' },
      },
    });
    expect(view).toMatchObject({
      provider: 'Cloudflare',
      sandboxType: 'Standard',
      kiloCliVersion: '7.4.20',
      wrapperVersion: '2.4.0',
      startedAt: now - 600_000,
      stoppedAt: null,
    });
    expect(view).not.toHaveProperty('runtimeCode');
    expect(JSON.stringify(view)).not.toContain('PRIVATE_');
  });

  it('preserves known lifecycle dates on a sleeping snapshot', () => {
    expect(
      sandboxStatusPresentation({
        ...observation,
        data: {
          ...snapshot,
          status: 'sleeping',
          detailCode: 'sandbox_stopped',
          estimatedSleepAt: null,
          provider: 'Vercel',
          runtime: {
            ...runtime,
            sandboxType: 'isolated-small',
            stoppedAt: now - 60_000,
          },
        },
      })
    ).toMatchObject({
      status: 'sleeping',
      provider: 'Vercel',
      sandboxType: 'Small',
      kiloCliVersion: '7.4.20',
      wrapperVersion: '2.4.0',
      startedAt: now - 600_000,
      stoppedAt: now - 60_000,
      estimatedSleepAt: null,
      sleepMinutesRemaining: null,
    });
  });

  it('does not invent versions or dates for older snapshots', () => {
    expect(sandboxStatusPresentation(observation)).toMatchObject({
      kiloCliVersion: null,
      wrapperVersion: null,
      sandboxType: 'Unknown',
      startedAt: null,
      stoppedAt: null,
    });
  });

  it.each([
    { kiloCliVersion: null, wrapperVersion: '2.4.0' },
    { kiloCliVersion: '7.4.20', wrapperVersion: null },
    { kiloCliVersion: null, wrapperVersion: null },
    { kiloCliVersion: '7.4.20-canary.123', wrapperVersion: '2.4.0-rc.1' },
  ])('preserves validated nullable runtime versions: %j', versions => {
    expect(
      sandboxStatusPresentation({
        ...observation,
        data: { ...snapshot, runtime: { ...runtime, ...versions } },
      })
    ).toMatchObject({
      ...versions,
      status: 'active',
      sandboxType: 'Standard',
      startedAt: now - 600_000,
      stoppedAt: null,
    });
  });

  it('preserves runtime versions when the authoritative lifecycle is unknown', () => {
    expect(
      sandboxStatusPresentation({
        ...observation,
        data: {
          ...snapshot,
          runtime,
          status: 'unknown',
          detailCode: 'insufficient_evidence',
          estimatedSleepAt: null,
        },
      })
    ).toMatchObject({
      status: 'unknown',
      provider: 'Cloudflare',
      sandboxType: 'Standard',
      kiloCliVersion: '7.4.20',
      wrapperVersion: '2.4.0',
      startedAt: now - 600_000,
      stoppedAt: null,
      estimatedSleepAt: null,
      sleepMinutesRemaining: null,
    });
  });

  it.each(['paused', 'unavailable', 'checking'] as const)(
    'does not retain cached runtime details when %s',
    state => {
      expect(
        sandboxStatusPresentation({
          ...observation,
          observation: state,
          data: { ...snapshot, runtime: { ...runtime, sandboxType: 'devcontainer' } },
        })
      ).toMatchObject({
        status: 'unknown',
        provider: 'Unknown',
        sandboxType: 'Unknown',
        kiloCliVersion: null,
        wrapperVersion: null,
        startedAt: null,
        stoppedAt: null,
        estimatedSleepAt: null,
        sleepMinutesRemaining: null,
      });
    }
  );

  it.each([
    null,
    undefined,
    { ...snapshot, provider: 'PRIVATE_SENTINEL' },
    { ...snapshot, detailCode: 'PRIVATE_SENTINEL' },
    { ...snapshot, status: 'PRIVATE_SENTINEL' },
    { ...snapshot, status: 'sleeping' },
    { ...snapshot, observedAt: NaN },
    { ...snapshot, estimatedSleepAt: Infinity },
    { ...snapshot, runtime: { ...runtime, kiloCliVersion: 'PRIVATE_SENTINEL' } },
    { ...snapshot, runtime: { ...runtime, wrapperVersion: 'PRIVATE_SENTINEL' } },
    { ...snapshot, runtime: { ...runtime, kiloCliVersion: '7.4.20\nPRIVATE_SENTINEL' } },
    { ...snapshot, runtime: { ...runtime, wrapperVersion: '2.4.0+PRIVATE_SENTINEL' } },
    { ...snapshot, runtime: { ...runtime, sandboxType: 'PRIVATE_SENTINEL' } },
  ])('fails closed for malformed data without exposing values: %j', data => {
    const view = sandboxStatusPresentation({ ...observation, data });
    expect(view).toMatchObject({
      status: 'unknown',
      provider: 'Unknown',
      kiloCliVersion: null,
      wrapperVersion: null,
      estimatedSleepAt: null,
      sleepMinutesRemaining: null,
    });
    expect(JSON.stringify(view)).not.toContain('PRIVATE_SENTINEL');
  });
});

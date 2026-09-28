import { describe, expect, it } from 'vitest';
import { projectStatus } from './status.js';
import type { AllocationRecord } from '../model/allocation.js';
import { POLICY } from '../schedule.js';

const NOW = 6_000_000;

function record(state: AllocationRecord['state'], resumable = true): AllocationRecord {
  return { v: 2, resumable, state };
}

const TARGET = {
  provider: 'cloudflare' as const,
  providerRef: 'ref',
  capabilities: { persistentWorkspace: false, destroysOnStop: true },
};

describe('public status projection', () => {
  it('requires the owner and an allocation record', () => {
    expect(projectStatus({ allocation: null, ownerPresent: true, now: NOW })).toEqual({
      status: 'unknown',
      detailCode: 'insufficient_evidence',
    });
    expect(
      projectStatus({
        allocation: record({ kind: 'stopped', summary: null }),
        ownerPresent: false,
        now: NOW,
      })
    ).toEqual({
      status: 'unknown',
      detailCode: 'insufficient_evidence',
    });
  });

  it('maps flat allocation states', () => {
    expect(
      projectStatus({
        allocation: record({ kind: 'stopped', summary: null }),
        ownerPresent: true,
        now: NOW,
      })
    ).toEqual({
      status: 'sleeping',
      detailCode: 'sandbox_stopped',
    });
    const creating: AllocationRecord['state'] = {
      kind: 'creating',
      requestId: 'r',
      target: TARGET,
      createIntent: { intentId: 'i', createdAt: NOW },
      attempt: 1,
      deadlineAt: NOW + 1_000,
    };
    expect(
      projectStatus({ allocation: record(creating), ownerPresent: true, now: NOW }).status
    ).toBe('starting');
    const unknown: AllocationRecord['state'] = {
      kind: 'unknown',
      target: TARGET,
      createIntent: { intentId: 'i', createdAt: NOW },
      stopIntent: null,
      attempts: 0,
      reason: 'x',
      deadlineAt: NOW + 1_000,
    };
    expect(
      projectStatus({ allocation: record(unknown), ownerPresent: true, now: NOW }).detailCode
    ).toBe('insufficient_evidence');
  });

  it('maps connecting, recovering and unhealthy health', () => {
    const connecting: AllocationRecord['state'] = {
      kind: 'allocated',
      target: TARGET,
      createIntent: { intentId: 'i', createdAt: NOW },
      health: { kind: 'connecting', incarnation: 'inc', deadlineAt: NOW + 1_000 },
      idleAt: null,
    };
    expect(projectStatus({ allocation: record(connecting), ownerPresent: true, now: NOW })).toEqual(
      {
        status: 'starting',
        detailCode: 'sandbox_starting',
      }
    );

    const recovering: AllocationRecord['state'] = {
      ...connecting,
      health: {
        kind: 'recovering',
        incarnation: 'inc',
        step: 'check_sandbox',
        attempts: 1,
        deadlineAt: NOW + 1_000,
        episodeId: '11111111-1111-4111-8111-111111111111',
        cause: 'activation_pending',
      },
    };
    expect(projectStatus({ allocation: record(recovering), ownerPresent: true, now: NOW })).toEqual(
      {
        status: 'unreachable',
        detailCode: 'connection_unavailable',
      }
    );

    const absent: AllocationRecord['state'] = {
      ...connecting,
      health: { kind: 'unhealthy', incarnation: 'inc', verdict: 'absent' },
    };
    expect(projectStatus({ allocation: record(absent), ownerPresent: true, now: NOW })).toEqual({
      status: 'error',
      detailCode: 'sandbox_failed',
    });

    const unresponsive: AllocationRecord['state'] = {
      ...connecting,
      health: { kind: 'unhealthy', incarnation: 'inc', verdict: 'unresponsive' },
    };
    expect(
      projectStatus({ allocation: record(unresponsive), ownerPresent: true, now: NOW })
    ).toEqual({
      status: 'stopping',
      detailCode: 'sandbox_stopping',
    });
  });

  it('projects active for a fresh ready heartbeat', () => {
    const healthy: AllocationRecord['state'] = {
      kind: 'allocated',
      target: TARGET,
      createIntent: { intentId: 'i', createdAt: NOW },
      health: {
        kind: 'healthy',
        incarnation: 'inc',
        lastHeartbeat: { incarnation: 'inc', at: NOW - 1_000, ready: true },
        deadlineAt: NOW + POLICY.heartbeatExpiryMs,
      },
      idleAt: null,
    };
    expect(projectStatus({ allocation: record(healthy), ownerPresent: true, now: NOW })).toEqual({
      status: 'active',
      detailCode: 'sandbox_ready',
    });
  });

  it('projects check_needed from the canonical health deadline before the timer fires', () => {
    const expired: AllocationRecord['state'] = {
      kind: 'allocated',
      target: TARGET,
      createIntent: { intentId: 'i', createdAt: NOW },
      health: {
        kind: 'healthy',
        incarnation: 'inc',
        lastHeartbeat: { incarnation: 'inc', at: NOW - POLICY.heartbeatExpiryMs, ready: true },
        deadlineAt: NOW - 1,
      },
      idleAt: null,
    };
    expect(projectStatus({ allocation: record(expired), ownerPresent: true, now: NOW })).toEqual({
      status: 'unreachable',
      detailCode: 'check_needed',
    });
  });
});

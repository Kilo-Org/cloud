import { describe, expect, it } from 'vitest';
import { SandboxStatusSnapshotSchema } from '../../shared/sandbox-status.js';
import { initialAllocationState, type AllocationState } from './allocation.js';
import { projectAllocationStatusSnapshot } from './status-snapshot.js';

const OBSERVED_AT = 1_700_000_000_000;
const IDLE_MS = 600_000;

function allocation(overrides: Partial<AllocationState> = {}): AllocationState {
  return { ...initialAllocationState(), ...overrides };
}

function project(overrides: Partial<AllocationState> | null, provider: 'cloudflare' | 'vercel') {
  return projectAllocationStatusSnapshot({
    allocation: overrides === null ? null : { ...allocation(overrides), provider },
    observedAt: OBSERVED_AT,
    inactivityTimeoutMs: IDLE_MS,
  });
}

describe('projectAllocationStatusSnapshot', () => {
  it('reports unknown with insufficient evidence and no provider', () => {
    const snapshot = project(null, 'cloudflare');
    expect(snapshot).toEqual({
      status: 'unknown',
      detailCode: 'insufficient_evidence',
      provider: 'Unknown',
      observedAt: OBSERVED_AT,
      inactivityTimeoutMs: IDLE_MS,
      estimatedSleepAt: null,
    });
  });

  it.each([
    ['creating', 'starting', 'sandbox_starting'],
    ['starting', 'starting', 'sandbox_starting'],
    ['stopping', 'stopping', 'sandbox_stopping'],
    ['stopped', 'sleeping', 'sandbox_stopped'],
    ['disconnected', 'unreachable', 'connection_unavailable'],
  ] as const)('maps %s to %s/%s', (kind, status, detailCode) => {
    const snapshot = project({ kind }, 'cloudflare');
    expect(snapshot).toMatchObject({ status, detailCode, provider: 'Cloudflare' });
    expect(snapshot.estimatedSleepAt).toBeNull();
    expect(SandboxStatusSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('maps a connected allocation to active and labels the provider', () => {
    const snapshot = project({ kind: 'connected', lastActivityAt: OBSERVED_AT - 1_000 }, 'vercel');
    expect(snapshot).toMatchObject({
      status: 'active',
      detailCode: 'sandbox_ready',
      provider: 'Vercel',
      inactivityTimeoutMs: IDLE_MS,
      estimatedSleepAt: OBSERVED_AT - 1_000 + IDLE_MS,
    });
    expect(SandboxStatusSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it.each(['cloudflare', 'vercel'] as const)(
    'reports unknown for an unconfirmed stop on %s',
    provider => {
      const snapshot = project(
        { kind: 'stopped', unconfirmedProviderRef: 'unconfirmed-provider-reference' },
        provider
      );
      expect(snapshot).toMatchObject({
        status: 'unknown',
        detailCode: 'insufficient_evidence',
        estimatedSleepAt: null,
      });
      expect(JSON.stringify(snapshot)).not.toContain('unconfirmed-provider-reference');
      expect(SandboxStatusSnapshotSchema.safeParse(snapshot).success).toBe(true);
    }
  );

  it('omits the sleep estimate when the idle anchor is missing or already past', () => {
    expect(
      project({ kind: 'connected', lastActivityAt: null }, 'cloudflare').estimatedSleepAt
    ).toBe(null);
    const stale = project(
      { kind: 'connected', lastActivityAt: OBSERVED_AT - (IDLE_MS + 1) },
      'cloudflare'
    );
    expect(stale.estimatedSleepAt).toBeNull();
    expect(SandboxStatusSnapshotSchema.safeParse(stale).success).toBe(true);
  });

  it('passes the inactivity bound through for every kind', () => {
    const snapshot = projectAllocationStatusSnapshot({
      allocation: { ...allocation({ kind: 'stopped' }), provider: 'cloudflare' },
      observedAt: OBSERVED_AT,
      inactivityTimeoutMs: 12_345,
    });
    expect(snapshot.inactivityTimeoutMs).toBe(12_345);
  });
});

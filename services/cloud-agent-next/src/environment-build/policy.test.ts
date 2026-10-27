import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_ELIGIBLE_LIFETIME_MS,
  SNAPSHOT_STALE_AFTER_MS,
  automaticAdmission,
  cleanupRetryDelay,
  replacementNeeded,
  snapshotEligibility,
  type PublishedSnapshot,
} from './policy.js';
import type { SessionEnvironmentReference } from './reference.js';

const NOW = 1_800_000_000_000;
const CURRENT = {
  baseImage: 'registry.example/app:1',
  runtimeAbi: 'abi',
  runtimeMode: 'preinstalled' as const,
};
const HOUR = 60 * 60_000;

const REFERENCE: SessionEnvironmentReference = {
  environmentId: '11111111-1111-4111-8111-111111111111',
  owner: { type: 'user', id: 'user-1' },
  configurationRevision: 2,
  repository: { platform: 'github', repoFullName: 'acme/widgets' },
};

function published(overrides: Partial<PublishedSnapshot> = {}): PublishedSnapshot {
  return {
    buildId: '22222222-2222-4222-8222-222222222222',
    environmentId: REFERENCE.environmentId,
    owner: REFERENCE.owner,
    revision: 2,
    repository: REFERENCE.repository,
    sourceCommit: 'a'.repeat(40),
    sourceBranch: 'main',
    provider: 'cloudflare-containers',
    baseImage: 'registry.example/app:1',
    runtimeAbi: 'abi',
    runtimeRelease: null,
    builderInstance: 'standard-4',
    snapshotId: 'snap-1',
    capturedAt: NOW - HOUR,
    publishedAt: NOW - HOUR,
    setupDurationMs: 1_000,
    ...overrides,
  };
}

describe('snapshotEligibility', () => {
  it('does not let preinstalled startup execute aliases from a downloaded snapshot', () => {
    const snapshot = published({ runtimeRelease: 'previous-release' });
    expect(snapshotEligibility(snapshot, REFERENCE, NOW, CURRENT)).toEqual({
      eligible: false,
      reason: 'incompatible',
    });
    expect(
      snapshotEligibility(snapshot, REFERENCE, NOW, { ...CURRENT, runtimeMode: 'downloaded' })
    ).toEqual({ eligible: true, stale: false });
  });

  it('uses a current snapshot without a replacement', () => {
    expect(snapshotEligibility(published(), REFERENCE, NOW, CURRENT)).toEqual({
      eligible: true,
      stale: false,
    });
    expect(replacementNeeded(published(), 2, NOW, CURRENT)).toBe(false);
  });

  it('keeps an older revision usable while marking it stale', () => {
    expect(snapshotEligibility(published({ revision: 1 }), REFERENCE, NOW, CURRENT)).toEqual({
      eligible: true,
      stale: true,
      staleReason: 'revision',
    });
    expect(replacementNeeded(published({ revision: 1 }), 2, NOW, CURRENT)).toBe(true);
  });

  it('keeps an age-stale snapshot usable and asks for a refresh', () => {
    const old = published({ capturedAt: NOW - SNAPSHOT_STALE_AFTER_MS });
    expect(snapshotEligibility(old, REFERENCE, NOW, CURRENT)).toEqual({
      eligible: true,
      stale: true,
      staleReason: 'age',
    });
    expect(replacementNeeded(old, 2, NOW, CURRENT)).toBe(true);
  });

  it('never gives an older session a newer revision', () => {
    expect(snapshotEligibility(published({ revision: 3 }), REFERENCE, NOW, CURRENT)).toEqual({
      eligible: false,
      reason: 'newer_than_session',
    });
  });

  it('rejects another owner, repository or environment, and an expired snapshot', () => {
    expect(
      snapshotEligibility(
        published({ owner: { type: 'user', id: 'other' } }),
        REFERENCE,
        NOW,
        CURRENT
      )
    ).toEqual({ eligible: false, reason: 'scope_mismatch' });
    expect(
      snapshotEligibility(
        published({ repository: { platform: 'github', repoFullName: 'acme/other' } }),
        REFERENCE,
        NOW,
        CURRENT
      )
    ).toEqual({ eligible: false, reason: 'scope_mismatch' });
    expect(
      snapshotEligibility(
        published({ environmentId: '33333333-3333-4333-8333-333333333333' }),
        REFERENCE,
        NOW,
        CURRENT
      )
    ).toEqual({ eligible: false, reason: 'scope_mismatch' });
    expect(
      snapshotEligibility(
        published({ capturedAt: NOW - SNAPSHOT_ELIGIBLE_LIFETIME_MS }),
        REFERENCE,
        NOW,
        CURRENT
      )
    ).toEqual({ eligible: false, reason: 'expired' });
    expect(snapshotEligibility(null, REFERENCE, NOW, CURRENT)).toEqual({
      eligible: false,
      reason: 'missing',
    });
  });

  it('treats another base image or runtime ABI as incompatible and asks for a replacement', () => {
    const otherImage = { ...CURRENT, baseImage: 'registry.example/app:2' };
    expect(snapshotEligibility(published(), REFERENCE, NOW, otherImage)).toEqual({
      eligible: false,
      reason: 'incompatible',
    });
    expect(replacementNeeded(published(), 2, NOW, otherImage)).toBe(true);
    expect(
      snapshotEligibility(published(), REFERENCE, NOW, { ...CURRENT, runtimeAbi: 'abi-2' })
    ).toEqual({ eligible: false, reason: 'incompatible' });
  });

  it('leaves the image check to the container when the current image is unknown', () => {
    const unknown = { ...CURRENT, baseImage: null };
    expect(snapshotEligibility(published(), REFERENCE, NOW, unknown).eligible).toBe(true);
    expect(replacementNeeded(published(), 2, NOW, unknown)).toBe(false);
  });

  it('compares a GitHub repository case-insensitively', () => {
    expect(
      snapshotEligibility(
        published({ repository: { platform: 'github', repoFullName: 'Acme/Widgets' } }),
        REFERENCE,
        NOW,
        CURRENT
      ).eligible
    ).toBe(true);
  });
});

describe('automaticAdmission', () => {
  it('admits the first attempt and after the backoff steps', () => {
    expect(automaticAdmission(null, NOW)).toEqual({ admit: true });
    const once = { failures: 1, lastFailureAt: NOW, lastAdmittedAt: NOW };
    expect(automaticAdmission(once, NOW + 9 * 60_000)).toEqual({
      admit: false,
      retryAt: NOW + 10 * 60_000,
    });
    expect(automaticAdmission(once, NOW + 10 * 60_000)).toEqual({ admit: true });
    const twice = { failures: 2, lastFailureAt: NOW, lastAdmittedAt: NOW };
    expect(automaticAdmission(twice, NOW + 59 * 60_000).admit).toBe(false);
    expect(automaticAdmission(twice, NOW + HOUR)).toEqual({ admit: true });
  });

  it('admits at most one automatic build per day after three failures', () => {
    const many = { failures: 3, lastFailureAt: NOW, lastAdmittedAt: NOW - HOUR };
    expect(automaticAdmission(many, NOW + 23 * HOUR)).toEqual({
      admit: false,
      retryAt: NOW + 24 * HOUR,
    });
    expect(automaticAdmission(many, NOW + 24 * HOUR)).toEqual({ admit: true });
  });
});

describe('cleanupRetryDelay', () => {
  it('backs off to a bounded interval', () => {
    expect(cleanupRetryDelay(1)).toBe(5_000);
    expect(cleanupRetryDelay(2)).toBe(10_000);
    expect(cleanupRetryDelay(20)).toBe(5 * 60_000);
  });
});

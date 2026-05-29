import { describe, expect, it, vi, beforeEach } from 'vitest';
import { platform } from './platform';
import { lookupKiloclawRolloutContextByInstanceId } from '../lib/user-flags';
import { resolveLatestVersion } from '../lib/image-version';
import { selectImageVersionForInstance } from '../lib/version-rollout';
import type { ImageVersionEntry } from '../schemas/image-version';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock('../lib/image-version', () => ({
  listAllVersions: vi.fn(),
  resolveLatestVersion: vi.fn(),
  updateTagIndex: vi.fn(),
}));

vi.mock('../lib/user-flags', () => ({
  setKiloclawEarlyAccess: vi.fn(),
  lookupKiloclawRolloutContextByInstanceId: vi.fn(),
}));

vi.mock('../lib/version-rollout', () => ({
  selectImageVersionForInstance: vi.fn(),
  setRolloutPercent: vi.fn(),
  markImageAsLatest: vi.fn(),
  disableImageAndClearRollout: vi.fn(),
}));

function makeEnv() {
  return {
    KV_CLAW_CACHE: {},
    HYPERDRIVE: { connectionString: 'postgres://test' },
  } as never;
}

function makeEnvWithoutHyperdrive() {
  return {
    KV_CLAW_CACHE: {},
  } as never;
}

const selectedVersion: ImageVersionEntry = {
  openclawVersion: '2.0.0',
  variant: 'default',
  imageTag: 'candidate-tag',
  imageDigest: null,
  publishedAt: '2026-05-29T00:00:00.000Z',
  rolloutPercent: 50,
  isLatest: false,
};

describe('platform /versions/latest', () => {
  beforeEach(() => {
    vi.mocked(resolveLatestVersion).mockReset();
    vi.mocked(selectImageVersionForInstance).mockReset();
    vi.mocked(lookupKiloclawRolloutContextByInstanceId).mockReset();
  });

  it('uses instanceId-only callers for rollout selection, current tag suppression, and Early Access lookup', async () => {
    vi.mocked(lookupKiloclawRolloutContextByInstanceId).mockResolvedValue({
      rolloutSubject: 'instance-row-id',
      earlyAccess: true,
    });
    vi.mocked(selectImageVersionForInstance).mockResolvedValue(selectedVersion);

    const response = await platform.request(
      '/versions/latest?instanceId=instance-row-id&currentImageTag=current-tag',
      undefined,
      makeEnv()
    );

    expect(response.status).toBe(200);
    expect(resolveLatestVersion).not.toHaveBeenCalled();
    expect(lookupKiloclawRolloutContextByInstanceId).toHaveBeenCalledWith(
      'postgres://test',
      'instance-row-id'
    );
    expect(selectImageVersionForInstance).toHaveBeenCalledWith({
      kv: {},
      variant: 'default',
      rolloutSubject: 'instance-row-id',
      currentImageTag: 'current-tag',
      autoEnroll: true,
    });
  });

  it('does not let caller-supplied rolloutSubject borrow Early Access from an unrelated instance', async () => {
    vi.mocked(lookupKiloclawRolloutContextByInstanceId).mockResolvedValue({
      rolloutSubject: 'authoritative-row-subject',
      earlyAccess: true,
    });
    vi.mocked(selectImageVersionForInstance).mockResolvedValue(selectedVersion);

    const response = await platform.request(
      '/versions/latest?rolloutSubject=caller-controlled-subject&instanceId=authoritative-early-access-instance',
      undefined,
      makeEnv()
    );

    expect(response.status).toBe(200);
    expect(lookupKiloclawRolloutContextByInstanceId).toHaveBeenCalledWith(
      'postgres://test',
      'authoritative-early-access-instance'
    );
    expect(selectImageVersionForInstance).toHaveBeenCalledWith({
      kv: {},
      variant: 'default',
      rolloutSubject: 'authoritative-row-subject',
      currentImageTag: null,
      autoEnroll: true,
    });
  });

  it('uses instanceId directly with autoEnroll disabled when Hyperdrive is unavailable', async () => {
    vi.mocked(selectImageVersionForInstance).mockResolvedValue(selectedVersion);

    const response = await platform.request(
      '/versions/latest?instanceId=instance-row-id&currentImageTag=current-tag',
      undefined,
      makeEnvWithoutHyperdrive()
    );

    expect(response.status).toBe(200);
    expect(resolveLatestVersion).not.toHaveBeenCalled();
    expect(lookupKiloclawRolloutContextByInstanceId).not.toHaveBeenCalled();
    expect(selectImageVersionForInstance).toHaveBeenCalledWith({
      kv: {},
      variant: 'default',
      rolloutSubject: 'instance-row-id',
      currentImageTag: 'current-tag',
      autoEnroll: false,
    });
  });

  it('returns :latest for anonymous callers without rollout parameters', async () => {
    vi.mocked(resolveLatestVersion).mockResolvedValue(selectedVersion);

    const response = await platform.request('/versions/latest', undefined, makeEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(selectedVersion);
    expect(resolveLatestVersion).toHaveBeenCalledWith({}, 'default');
    expect(lookupKiloclawRolloutContextByInstanceId).not.toHaveBeenCalled();
    expect(selectImageVersionForInstance).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { platform } from './platform';
import { lookupKiloclawEarlyAccessByInstanceId } from '../lib/user-flags';
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
  lookupKiloclawEarlyAccessByInstanceId: vi.fn(),
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
    vi.mocked(lookupKiloclawEarlyAccessByInstanceId).mockReset();
  });

  it('uses rolloutSubject for bucket math and instanceId for Early Access lookup', async () => {
    vi.mocked(lookupKiloclawEarlyAccessByInstanceId).mockResolvedValue(true);
    vi.mocked(selectImageVersionForInstance).mockResolvedValue(selectedVersion);

    const response = await platform.request(
      '/versions/latest?rolloutSubject=bucket-subject&instanceId=instance-row-id&userId=forged-user&currentImageTag=current-tag',
      undefined,
      makeEnv()
    );

    expect(response.status).toBe(200);
    expect(lookupKiloclawEarlyAccessByInstanceId).toHaveBeenCalledWith(
      'postgres://test',
      'instance-row-id'
    );
    expect(selectImageVersionForInstance).toHaveBeenCalledWith({
      kv: {},
      variant: 'default',
      instanceId: 'bucket-subject',
      currentImageTag: 'current-tag',
      autoEnroll: true,
    });
  });

  it('does not grant Early Access when rolloutSubject has no authoritative instanceId', async () => {
    vi.mocked(selectImageVersionForInstance).mockResolvedValue(selectedVersion);

    const response = await platform.request(
      '/versions/latest?rolloutSubject=bucket-subject&userId=early-access-user',
      undefined,
      makeEnv()
    );

    expect(response.status).toBe(200);
    expect(lookupKiloclawEarlyAccessByInstanceId).not.toHaveBeenCalled();
    expect(selectImageVersionForInstance).toHaveBeenCalledWith(
      expect.objectContaining({ autoEnroll: false })
    );
  });
});

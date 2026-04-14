import { describe, expect, it, vi } from 'vitest';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

type ProviderMetadata = {
  provider: 'fly' | 'northflank';
  capabilities: {
    volumeSnapshots: boolean;
    candidateVolumes: boolean;
    volumeReassociation: boolean;
    snapshotRestore: boolean;
    directMachineDestroy: boolean;
  };
};

function makeEnv(
  metadata: ProviderMetadata = {
    provider: 'fly',
    capabilities: {
      volumeSnapshots: true,
      candidateVolumes: true,
      volumeReassociation: true,
      snapshotRestore: true,
      directMachineDestroy: true,
    },
  }
) {
  const listVolumeSnapshots = vi.fn().mockResolvedValue([{ id: 'snap-1' }]);
  const listCandidateVolumes = vi.fn().mockResolvedValue({
    currentVolumeId: 'vol-1',
    volumes: [{ id: 'vol-1', isCurrent: true }],
  });
  const reassociateVolume = vi.fn().mockResolvedValue({
    previousVolumeId: 'vol-1',
    newVolumeId: 'vol-2',
    newRegion: 'ord',
  });
  const enqueueSnapshotRestore = vi.fn().mockResolvedValue({
    acknowledged: true,
    previousVolumeId: 'vol-1',
  });
  const getProviderMetadata = vi.fn().mockResolvedValue(metadata);

  return {
    env: {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({
          getProviderMetadata,
          listVolumeSnapshots,
          listCandidateVolumes,
          reassociateVolume,
          enqueueSnapshotRestore,
        }),
      },
      KILOCLAW_AE: { writeDataPoint: vi.fn() },
      KV_CLAW_CACHE: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
        getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
      },
    } as never,
    getProviderMetadata,
    listVolumeSnapshots,
    listCandidateVolumes,
    reassociateVolume,
    enqueueSnapshotRestore,
  };
}

describe('platform provider capability gates', () => {
  it('allows Fly volume snapshots', async () => {
    const { env, listVolumeSnapshots } = makeEnv();

    const response = await platform.request('/volume-snapshots?userId=user-1', undefined, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ snapshots: [{ id: 'snap-1' }] });
    expect(listVolumeSnapshots).toHaveBeenCalled();
  });

  it('rejects volume snapshot listing for unsupported providers', async () => {
    const { env, listVolumeSnapshots } = makeEnv({
      provider: 'northflank',
      capabilities: {
        volumeSnapshots: false,
        candidateVolumes: false,
        volumeReassociation: false,
        snapshotRestore: false,
        directMachineDestroy: false,
      },
    });

    const response = await platform.request('/volume-snapshots?userId=user-1', undefined, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'volume-snapshots is not supported for provider northflank',
    });
    expect(listVolumeSnapshots).not.toHaveBeenCalled();
  });

  it('rejects candidate volume listing for unsupported providers', async () => {
    const { env, listCandidateVolumes } = makeEnv({
      provider: 'northflank',
      capabilities: {
        volumeSnapshots: false,
        candidateVolumes: false,
        volumeReassociation: false,
        snapshotRestore: false,
        directMachineDestroy: false,
      },
    });

    const response = await platform.request('/candidate-volumes?userId=user-1', undefined, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'candidate-volumes is not supported for provider northflank',
    });
    expect(listCandidateVolumes).not.toHaveBeenCalled();
  });

  it('rejects volume reassociation for unsupported providers', async () => {
    const { env, reassociateVolume } = makeEnv({
      provider: 'northflank',
      capabilities: {
        volumeSnapshots: false,
        candidateVolumes: false,
        volumeReassociation: false,
        snapshotRestore: false,
        directMachineDestroy: false,
      },
    });

    const response = await platform.request(
      '/reassociate-volume',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          newVolumeId: 'vol-2',
          reason: 'reason for test reassociation',
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'reassociate-volume is not supported for provider northflank',
    });
    expect(reassociateVolume).not.toHaveBeenCalled();
  });

  it('rejects snapshot restore for unsupported providers', async () => {
    const { env, enqueueSnapshotRestore } = makeEnv({
      provider: 'northflank',
      capabilities: {
        volumeSnapshots: false,
        candidateVolumes: false,
        volumeReassociation: false,
        snapshotRestore: false,
        directMachineDestroy: false,
      },
    });

    const response = await platform.request(
      '/restore-volume-snapshot',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          snapshotId: 'snap-1',
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'restore-volume-snapshot is not supported for provider northflank',
    });
    expect(enqueueSnapshotRestore).not.toHaveBeenCalled();
  });

  it('fails open for volume snapshots when provider metadata lookup is unavailable', async () => {
    const { env, getProviderMetadata, listVolumeSnapshots } = makeEnv();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getProviderMetadata.mockRejectedValueOnce(new Error('DO unavailable'));

    const response = await platform.request('/volume-snapshots?userId=user-1', undefined, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ snapshots: [{ id: 'snap-1' }] });
    expect(listVolumeSnapshots).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});

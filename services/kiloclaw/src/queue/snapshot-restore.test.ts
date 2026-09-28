import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSnapshotRestoreQueue } from './snapshot-restore';
import * as fly from '../fly/client';
import type * as flyClientModule from '../fly/client';
import type { FlyVolume, FlyVolumeSnapshot } from '../fly/types';
import type { KiloClawEnv } from '../types';
import type { SnapshotRestoreMessage } from '../schemas/snapshot-restore';

vi.mock('../fly/client', async importOriginal => {
  const actual = await importOriginal<typeof flyClientModule>();
  return {
    ...actual,
    getVolume: vi.fn(),
    listVolumes: vi.fn(),
    listVolumeSnapshots: vi.fn(),
    createVolume: vi.fn(),
  };
});

const flyMock = vi.mocked(fly);
const GIB = 1024 ** 3;

const MESSAGE: SnapshotRestoreMessage = {
  userId: 'user-1',
  snapshotId: 'vs-1',
  previousVolumeId: 'vol-current',
  region: 'ord',
  instanceId: 'inst-1',
};

function volume(overrides: Partial<FlyVolume> = {}): FlyVolume {
  return {
    id: 'vol-current',
    name: 'kiloclaw_volume',
    state: 'created',
    size_gb: 10,
    region: 'ord',
    attached_machine_id: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function snapshot(overrides: Partial<FlyVolumeSnapshot> = {}): FlyVolumeSnapshot {
  return {
    id: 'vs-1',
    created_at: '2026-01-01T00:00:00Z',
    digest: 'digest',
    retention_days: 5,
    size: 1,
    status: 'created',
    volume_size: 10 * GIB,
    ...overrides,
  };
}

function makeStub() {
  return {
    getStatus: vi.fn().mockResolvedValue({ flyVolumeId: 'vol-current', flyAppName: 'acct-test' }),
    stop: vi.fn().mockResolvedValue(undefined),
    destroyMachineForRestore: vi.fn().mockResolvedValue(undefined),
    getDebugState: vi.fn().mockResolvedValue({ pendingRestoreVolumeId: null }),
    setPendingRestoreVolumeId: vi.fn().mockResolvedValue(undefined),
    completeSnapshotRestore: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEnv(stub: ReturnType<typeof makeStub>): KiloClawEnv {
  return {
    KILOCLAW_INSTANCE: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
    FLY_API_TOKEN: 'token',
    FLY_APP_NAME: 'fallback-app',
  } as unknown as KiloClawEnv;
}

function makeBatch(body: SnapshotRestoreMessage = MESSAGE) {
  const message = { body, ack: vi.fn(), retry: vi.fn(), attempts: 1 };
  const batch = {
    messages: [message],
  } as unknown as Parameters<typeof handleSnapshotRestoreQueue>[0];
  return { batch, message };
}

beforeEach(() => {
  vi.clearAllMocks();
  flyMock.getVolume.mockResolvedValue(volume());
  flyMock.listVolumes.mockResolvedValue([volume(), volume({ id: 'vol-previous', size_gb: 11 })]);
  flyMock.listVolumeSnapshots.mockResolvedValue([]);
  flyMock.createVolume.mockResolvedValue(volume({ id: 'vol-restored' }));
});

describe('handleSnapshotRestoreQueue', () => {
  it('sizes the restore volume from the snapshot source when it is larger than the current volume', async () => {
    flyMock.listVolumeSnapshots.mockImplementation(async (_config, volumeId) =>
      volumeId === 'vol-previous' ? [snapshot({ volume_size: 11 * GIB })] : []
    );

    const { batch, message } = makeBatch();
    await handleSnapshotRestoreQueue(batch, makeEnv(makeStub()));

    expect(flyMock.createVolume).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ snapshot_id: 'vs-1', size_gb: 11 })
    );
    expect(message.ack).toHaveBeenCalled();
  });

  it('keeps the current volume size when the snapshot is smaller than the current volume', async () => {
    flyMock.getVolume.mockResolvedValue(volume({ size_gb: 20 }));
    flyMock.listVolumes.mockResolvedValue([volume({ id: 'vol-current', size_gb: 20 })]);
    flyMock.listVolumeSnapshots.mockResolvedValue([snapshot({ volume_size: 11 * GIB })]);

    const { batch } = makeBatch();
    await handleSnapshotRestoreQueue(batch, makeEnv(makeStub()));

    expect(flyMock.createVolume).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ size_gb: 20 })
    );
  });

  it('tolerates a volume that vanishes during the snapshot scan', async () => {
    flyMock.listVolumes.mockResolvedValue([
      volume({ id: 'vol-current', size_gb: 10 }),
      volume({ id: 'vol-gone', size_gb: 11 }),
      volume({ id: 'vol-previous', size_gb: 11 }),
    ]);
    flyMock.listVolumeSnapshots.mockImplementation(async (_config, volumeId) => {
      if (volumeId === 'vol-gone') {
        throw new fly.FlyApiError('volume not found', 400, '{"error":"volume not found"}');
      }
      return volumeId === 'vol-previous' ? [snapshot({ volume_size: 11 * GIB })] : [];
    });

    const { batch, message } = makeBatch();
    await handleSnapshotRestoreQueue(batch, makeEnv(makeStub()));

    expect(flyMock.createVolume).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ size_gb: 11 })
    );
    expect(message.ack).toHaveBeenCalled();
  });

  it('does not scan volumes smaller than the current volume', async () => {
    flyMock.listVolumes.mockResolvedValue([
      volume({ id: 'vol-current', size_gb: 10 }),
      volume({ id: 'vol-small', size_gb: 5 }),
    ]);

    const { batch } = makeBatch();
    await handleSnapshotRestoreQueue(batch, makeEnv(makeStub()));

    expect(flyMock.listVolumeSnapshots).toHaveBeenCalledWith(expect.anything(), 'vol-current');
    expect(flyMock.listVolumeSnapshots).not.toHaveBeenCalledWith(expect.anything(), 'vol-small');
    expect(flyMock.createVolume).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ size_gb: 10 })
    );
  });

  it('falls back to the current volume size when the snapshot is not found', async () => {
    const { batch } = makeBatch();
    await handleSnapshotRestoreQueue(batch, makeEnv(makeStub()));

    expect(flyMock.createVolume).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ size_gb: 10 })
    );
  });

  it('swaps the volume and starts the machine on success', async () => {
    flyMock.listVolumeSnapshots.mockResolvedValue([snapshot({ volume_size: 10 * GIB })]);
    flyMock.createVolume.mockResolvedValue(volume({ id: 'vol-restored', region: 'ord' }));
    const stub = makeStub();

    const { batch, message } = makeBatch();
    await handleSnapshotRestoreQueue(batch, makeEnv(stub));

    expect(stub.setPendingRestoreVolumeId).toHaveBeenCalledWith('vol-restored');
    expect(stub.completeSnapshotRestore).toHaveBeenCalledWith('vol-restored', 'ord');
    expect(stub.start).toHaveBeenCalledWith('user-1', { reason: 'snapshot_restore' });
    expect(message.ack).toHaveBeenCalled();
  });

  it('acks without restoring when the volume was already swapped', async () => {
    const stub = makeStub();
    stub.getStatus.mockResolvedValue({ flyVolumeId: 'vol-other', flyAppName: 'acct-test' });

    const { batch, message } = makeBatch();
    await handleSnapshotRestoreQueue(batch, makeEnv(stub));

    expect(flyMock.createVolume).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from './platform';
import * as fly from '../fly/client';
import type * as FlyClient from '../fly/client';
import { FlyApiError } from '../fly/client';
import { volumeNameFromSandboxId } from '../durable-objects/machine-config';
import type { FlyVolume } from '../fly/types';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock('../fly/client', async () => {
  const actual = await vi.importActual<typeof FlyClient>('../fly/client');
  return {
    ...actual,
    listVolumes: vi.fn(),
    deleteVolume: vi.fn(),
  };
});

/**
 * Coverage for the admin orphan-volume reaper endpoints in platform.ts:
 *   GET  /api/platform/admin/orphan-volume-scan
 *   POST /api/platform/admin/orphan-volume-destroy
 *
 * The destroy endpoint is the only destructive path; every refusal guard
 * (name mismatch, non-quiescent state, attached machine, live DO reference,
 * live DO, unconfirmable DO state) gets an explicit test here.
 */

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-1';
const SANDBOX_ID = 'ki_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VOLUME_NAME = volumeNameFromSandboxId(SANDBOX_ID);

/** A finalized DO: storage wiped, every field null. */
const FINALIZED_DO_STATE = {
  status: null,
  flyVolumeId: null,
  pendingDestroyVolumeId: null,
  pendingRecoveryVolumeId: null,
  recoveryPreviousVolumeId: null,
  previousVolumeId: null,
  pendingRestoreVolumeId: null,
};

function makeEnv(opts?: { flyApiToken?: string | null; debugState?: unknown }) {
  const flyApiToken = opts?.flyApiToken === undefined ? 'test-token' : opts.flyApiToken;
  const getDebugState =
    opts?.debugState instanceof Error
      ? vi.fn().mockRejectedValue(opts.debugState)
      : vi.fn().mockResolvedValue(opts?.debugState ?? FINALIZED_DO_STATE);
  return {
    env: {
      FLY_API_TOKEN: flyApiToken ?? undefined,
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ getDebugState }),
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
    getDebugState,
  };
}

function flyVolume(overrides: Partial<FlyVolume> = {}): FlyVolume {
  return {
    id: 'vol_orphan0000000000',
    name: VOLUME_NAME,
    state: 'created',
    size_gb: 10,
    region: 'ord',
    attached_machine_id: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function scanPath() {
  const params = new URLSearchParams({
    userId: USER_ID,
    instanceId: INSTANCE_ID,
    sandboxId: SANDBOX_ID,
  });
  return `/admin/orphan-volume-scan?${params.toString()}`;
}

function destroyInit(body: Record<string, unknown>) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const validDestroyBody = {
  userId: USER_ID,
  instanceId: INSTANCE_ID,
  sandboxId: SANDBOX_ID,
  volumeId: 'vol_orphan0000000000',
};

beforeEach(() => {
  vi.mocked(fly.listVolumes).mockReset();
  vi.mocked(fly.deleteVolume).mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /admin/orphan-volume-scan', () => {
  it('returns 503 when FLY_API_TOKEN is not configured', async () => {
    const { env } = makeEnv({ flyApiToken: null });
    const response = await platform.request(scanPath(), {}, env);
    expect(response.status).toBe(503);
  });

  it('returns 400 when required identity params are missing', async () => {
    const { env } = makeEnv();
    const response = await platform.request(`/admin/orphan-volume-scan?userId=${USER_ID}`, {}, env);
    expect(response.status).toBe(400);
  });

  it('annotates the volume that name-matches the instance', async () => {
    const { env } = makeEnv();
    vi.mocked(fly.listVolumes).mockResolvedValue([
      flyVolume(),
      flyVolume({ id: 'vol_other0000000000', name: 'kiloclaw_ki_someoneelse000000' }),
    ]);

    const response = await platform.request(scanPath(), {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      appExists: boolean;
      expectedVolumeName: string;
      doStatus: string | null;
      volumes: Array<{ id: string; nameMatchesInstance: boolean }>;
    };

    expect(body.appExists).toBe(true);
    expect(body.expectedVolumeName).toBe(VOLUME_NAME);
    expect(body.doStatus).toBeNull();
    expect(body.volumes.find(v => v.id === 'vol_orphan0000000000')?.nameMatchesInstance).toBe(true);
    expect(body.volumes.find(v => v.id === 'vol_other0000000000')?.nameMatchesInstance).toBe(false);
  });

  it('flags volumes a live DO still tracks', async () => {
    const { env } = makeEnv({
      debugState: { ...FINALIZED_DO_STATE, status: 'running', flyVolumeId: 'vol_orphan0000000000' },
    });
    vi.mocked(fly.listVolumes).mockResolvedValue([flyVolume()]);

    const response = await platform.request(scanPath(), {}, env);
    const body = (await response.json()) as {
      doStatus: string | null;
      volumes: Array<{ id: string; trackedByLiveDo: boolean }>;
    };
    expect(body.doStatus).toBe('running');
    expect(body.volumes[0]?.trackedByLiveDo).toBe(true);
  });

  it('reports appExists=false when the Fly app is gone (404)', async () => {
    const { env } = makeEnv();
    vi.mocked(fly.listVolumes).mockRejectedValue(new FlyApiError('not found', 404, ''));

    const response = await platform.request(scanPath(), {}, env);
    const body = (await response.json()) as { appExists: boolean; volumes: unknown[] };
    expect(body.appExists).toBe(false);
    expect(body.volumes).toEqual([]);
  });

  it('surfaces a non-404 listVolumes failure as scanError (never a silent empty)', async () => {
    const { env } = makeEnv();
    vi.mocked(fly.listVolumes).mockRejectedValue(
      new FlyApiError('Fly API listVolumes failed (403): blocked', 403, 'blocked')
    );

    const response = await platform.request(scanPath(), {}, env);
    const body = (await response.json()) as { scanError: string | null; volumes: unknown[] };
    expect(body.scanError).toContain('403');
    expect(body.volumes).toEqual([]);
  });
});

describe('POST /admin/orphan-volume-destroy', () => {
  it('returns 503 when FLY_API_TOKEN is not configured', async () => {
    const { env } = makeEnv({ flyApiToken: null });
    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(503);
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('returns 404 when the volume is not in the Fly app', async () => {
    const { env } = makeEnv();
    vi.mocked(fly.listVolumes).mockResolvedValue([]);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(404);
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('refuses (409) when the volume name does not match the instance', async () => {
    const { env } = makeEnv();
    vi.mocked(fly.listVolumes).mockResolvedValue([
      flyVolume({ name: 'kiloclaw_ki_someoneelse000000' }),
    ]);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(409);
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('refuses (409) when the volume is not in a quiescent state', async () => {
    const { env } = makeEnv();
    vi.mocked(fly.listVolumes).mockResolvedValue([flyVolume({ state: 'pending_destroy' })]);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(409);
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('refuses (409) when the volume is attached to a machine', async () => {
    const { env } = makeEnv();
    vi.mocked(fly.listVolumes).mockResolvedValue([
      flyVolume({ state: 'detached', attached_machine_id: 'm-123' }),
    ]);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(409);
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('refuses (409) when a live DO still references the volume', async () => {
    const { env } = makeEnv({
      debugState: {
        ...FINALIZED_DO_STATE,
        status: 'stopped',
        recoveryPreviousVolumeId: 'vol_orphan0000000000',
      },
    });
    vi.mocked(fly.listVolumes).mockResolvedValue([flyVolume()]);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(409);
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('refuses (409) when the DO is still alive', async () => {
    const { env } = makeEnv({ debugState: { ...FINALIZED_DO_STATE, status: 'running' } });
    vi.mocked(fly.listVolumes).mockResolvedValue([flyVolume()]);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(409);
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('refuses (502) when DO state cannot be confirmed', async () => {
    const { env } = makeEnv({ debugState: new Error('DO unreachable') });
    vi.mocked(fly.listVolumes).mockResolvedValue([flyVolume()]);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(502);
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('destroys the volume when every guard passes', async () => {
    const { env } = makeEnv();
    vi.mocked(fly.listVolumes).mockResolvedValue([flyVolume()]);
    vi.mocked(fly.deleteVolume).mockResolvedValue(undefined);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; alreadyGone: boolean };
    expect(body.ok).toBe(true);
    expect(body.alreadyGone).toBe(false);
    expect(fly.deleteVolume).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fly.deleteVolume).mock.calls[0]?.[1]).toBe('vol_orphan0000000000');
  });

  it('treats an already-deleted volume as success', async () => {
    const { env } = makeEnv();
    vi.mocked(fly.listVolumes).mockResolvedValue([flyVolume()]);
    vi.mocked(fly.deleteVolume).mockRejectedValue(new FlyApiError('gone', 404, ''));

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; alreadyGone: boolean };
    expect(body.ok).toBe(true);
    expect(body.alreadyGone).toBe(true);
  });
});

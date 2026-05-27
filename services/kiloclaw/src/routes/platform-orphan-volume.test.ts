import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from './platform';
import * as fly from '../fly/client';
import type * as FlyClient from '../fly/client';
import { FlyApiError } from '../fly/client';
import { getWorkerDb } from '../db';
import type * as DbModule from '../db';
import { sandboxIdFromUserId } from '../auth/sandbox-id';
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

// The destroy endpoint runs a gated instance+subscription lookup through
// `getWorkerDb`. Mock the DB layer so that query can be driven without a
// real Postgres connection (see `mockDestroyLookup`).
vi.mock('../db', async () => {
  const actual = await vi.importActual<typeof DbModule>('../db');
  return {
    ...actual,
    getWorkerDb: vi.fn(),
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

/**
 * Instance row for INSTANCE_ID that passes the identity / destroyed /
 * grace gates: identity matches, destroyed long ago, and the grace period
 * (`gracePeriodElapsed`, computed in SQL by the endpoint's instance query)
 * has elapsed.
 */
const DEFAULT_DESTROY_ROW = {
  id: INSTANCE_ID,
  userId: USER_ID,
  sandboxId: SANDBOX_ID,
  organizationId: null,
  destroyedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  gracePeriodElapsed: true,
};

/**
 * Build a fake worker DB for the destroy endpoint. It runs two queries on
 * one DB handle — the instance lookup (terminated by `.limit(1)`) and the
 * ownership-context protection lookup inside
 * `getOrphanVolumeContextProtections` (awaited directly, no `.limit`).
 * They resolve `instanceRows` and `subscriptionRows` respectively.
 */
function makeWorkerDb(instanceRows: unknown[], subscriptionRows: unknown[]) {
  return {
    select: () => {
      const chain: Record<string, unknown> = {
        from: () => chain,
        leftJoin: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(instanceRows),
        then: (onFulfilled: (rows: unknown[]) => unknown) =>
          Promise.resolve(subscriptionRows).then(onFulfilled),
      };
      return chain;
    },
  };
}

/**
 * Drive the destroy endpoint's DB queries: `instanceRow` is what the
 * instance lookup resolves; `subscriptions` are the current
 * (non-transferred) subscription rows the context protection query resolves
 * for the owning user.
 */
function mockDestroyLookup(
  instanceRow: Record<string, unknown> | null,
  subscriptions: Record<string, unknown>[] = []
): void {
  vi.mocked(getWorkerDb).mockReturnValue(
    makeWorkerDb(instanceRow === null ? [] : [instanceRow], subscriptions) as never
  );
}

/** A current subscription row linked to the destroyed row's ownership context. */
function accessGrantingSubscriptionRow(status: string): Record<string, unknown> {
  return {
    user_id: USER_ID,
    instance_id: INSTANCE_ID,
    instance_user_id: USER_ID,
    organization_id: null,
    status,
    suspended_at: null,
    trial_ends_at: null,
    destruction_deadline: null,
  };
}

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

function makeEnv(opts?: {
  flyApiToken?: string | null;
  debugState?: unknown;
  appName?: string | null;
}) {
  const flyApiToken = opts?.flyApiToken === undefined ? 'test-token' : opts.flyApiToken;
  const getDebugState =
    opts?.debugState instanceof Error
      ? vi.fn().mockRejectedValue(opts.debugState)
      : vi.fn().mockResolvedValue(opts?.debugState ?? FINALIZED_DO_STATE);
  const getAppName = vi.fn().mockResolvedValue(opts?.appName ?? null);
  return {
    env: {
      FLY_API_TOKEN: flyApiToken ?? undefined,
      HYPERDRIVE: { connectionString: 'postgres://test' },
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ getDebugState }),
      },
      KILOCLAW_APP: {
        idFromName: (id: string) => id,
        get: () => ({ getAppName }),
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
    getAppName,
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
  vi.mocked(getWorkerDb).mockReset();
  mockDestroyLookup(DEFAULT_DESTROY_ROW);
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

  it('lists volumes from the App DO stored Fly app name when present', async () => {
    const { env } = makeEnv({ appName: 'stored-fly-app' });
    vi.mocked(fly.listVolumes).mockResolvedValue([flyVolume()]);

    const response = await platform.request(scanPath(), {}, env);
    expect(response.status).toBe(200);
    expect(fly.listVolumes).toHaveBeenCalledWith({
      apiToken: 'test-token',
      appName: 'stored-fly-app',
    });
    const body = (await response.json()) as { flyApp: string };
    expect(body.flyApp).toBe('stored-fly-app');
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

  it('returns 404 when the instance row does not exist', async () => {
    const { env } = makeEnv();
    mockDestroyLookup(null);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(404);
    expect(fly.listVolumes).not.toHaveBeenCalled();
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('refuses (409) when userId/sandboxId do not match the resolved instanceId', async () => {
    const { env } = makeEnv();
    // The row for INSTANCE_ID belongs to a different sandbox than the body claims.
    mockDestroyLookup({
      ...DEFAULT_DESTROY_ROW,
      sandboxId: 'ki_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(409);
    expect(fly.listVolumes).not.toHaveBeenCalled();
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('reads the correct user-keyed DO for a legacy (non-ki_) sandbox', async () => {
    // Regression: the DO key must be derived from the sandbox ID, not the
    // raw instanceId. For a legacy sandbox the real DO is user-keyed; keying
    // off instanceId would read an unrelated empty DO and let the destroy
    // guards pass against the wrong instance.
    const legacyUserId = 'legacy-user-1';
    const legacySandbox = sandboxIdFromUserId(legacyUserId); // base64url, not ki_
    const legacyInstanceId = '22222222-2222-4222-8222-222222222222';
    const legacyVolumeId = 'vol_legacy0000000000';

    // The real (user-keyed) legacy DO is alive; every other key resolves to
    // a finalized/empty DO. If the endpoint keyed off instanceId it would
    // see the empty DO and wrongly permit the delete.
    const env = {
      FLY_API_TOKEN: 'test-token',
      HYPERDRIVE: { connectionString: 'postgres://test' },
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: (key: string) => ({
          getDebugState: vi
            .fn()
            .mockResolvedValue(
              key === legacyUserId
                ? { ...FINALIZED_DO_STATE, status: 'running' }
                : FINALIZED_DO_STATE
            ),
        }),
      },
      KILOCLAW_APP: {
        idFromName: (id: string) => id,
        get: () => ({ getAppName: vi.fn().mockResolvedValue(null) }),
      },
      KILOCLAW_AE: { writeDataPoint: vi.fn() },
      KV_CLAW_CACHE: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
        getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
      },
    } as never;

    mockDestroyLookup({
      id: legacyInstanceId,
      userId: legacyUserId,
      sandboxId: legacySandbox,
      organizationId: null,
      destroyedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      gracePeriodElapsed: true,
    });
    vi.mocked(fly.listVolumes).mockResolvedValue([
      flyVolume({ id: legacyVolumeId, name: volumeNameFromSandboxId(legacySandbox) }),
    ]);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit({
        userId: legacyUserId,
        instanceId: legacyInstanceId,
        sandboxId: legacySandbox,
        volumeId: legacyVolumeId,
      }),
      env
    );

    // The live legacy DO must block the delete — proving the user-keyed DO
    // (not an instanceId-keyed one) was the DO actually consulted.
    expect(response.status).toBe(409);
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

  it('refuses (409) when the instance is not destroyed', async () => {
    const { env } = makeEnv();
    mockDestroyLookup({ ...DEFAULT_DESTROY_ROW, destroyedAt: null });

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(409);
    expect(fly.listVolumes).not.toHaveBeenCalled();
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('refuses (409) while the instance is within the grace period', async () => {
    // `gracePeriodElapsed` is computed by the endpoint's instance query in
    // SQL — `max(destroyed_at)` of the (user, sandbox) versus the grace
    // window — so an older submitted row of a sandbox reprovisioned and
    // destroyed again recently is still blocked. That SQL is exercised
    // end-to-end against Postgres by the web router's `destroyOrphanVolume`
    // test; here the worker just honors the precomputed flag.
    const { env } = makeEnv();
    mockDestroyLookup({
      ...DEFAULT_DESTROY_ROW,
      gracePeriodElapsed: false,
    });

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(409);
    expect(fly.listVolumes).not.toHaveBeenCalled();
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('refuses (409) when the user has a current access-granting subscription', async () => {
    // Models the reprovision case: the destroyed instance's own subscription
    // was transferred away, but the same ownership context still has access via
    // a current successor subscription. The context gate must block the delete.
    const { env } = makeEnv();
    mockDestroyLookup(DEFAULT_DESTROY_ROW, [accessGrantingSubscriptionRow('active')]);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(409);
    expect(fly.listVolumes).not.toHaveBeenCalled();
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('allows destroy when an access-granting subscription belongs to another context', async () => {
    const { env } = makeEnv();
    mockDestroyLookup(DEFAULT_DESTROY_ROW, [
      {
        ...accessGrantingSubscriptionRow('active'),
        instance_id: '22222222-2222-4222-8222-222222222222',
        organization_id: '33333333-3333-4333-8333-333333333333',
      },
    ]);
    vi.mocked(fly.listVolumes).mockResolvedValue([flyVolume()]);
    vi.mocked(fly.deleteVolume).mockResolvedValue(undefined);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(200);
    expect(fly.deleteVolume).toHaveBeenCalledTimes(1);
  });

  it('refuses (409) when the user has a current live trial', async () => {
    // The Odai case: the destroyed instance's own subscription is canceled,
    // but the user has a detached trialing subscription whose trial has not
    // ended. The context cannot be resolved safely, so it must fail closed.
    const { env } = makeEnv();
    mockDestroyLookup(DEFAULT_DESTROY_ROW, [
      {
        user_id: USER_ID,
        instance_id: null,
        instance_user_id: null,
        organization_id: null,
        status: 'trialing',
        suspended_at: null,
        trial_ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        destruction_deadline: null,
      },
    ]);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(409);
    expect(fly.listVolumes).not.toHaveBeenCalled();
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('refuses (409) when the user has a pending billing destruction deadline', async () => {
    // The Stefan case: the subscription is canceled and not access-granting,
    // but its billing destruction_deadline is still in the future — the
    // kiloclaw-billing lifecycle reaper is already scheduled to destroy the
    // instance and its volume, so the orphan reaper must not race it.
    const { env } = makeEnv();
    mockDestroyLookup(DEFAULT_DESTROY_ROW, [
      {
        user_id: USER_ID,
        instance_id: INSTANCE_ID,
        instance_user_id: USER_ID,
        organization_id: null,
        status: 'canceled',
        suspended_at: new Date(Date.now() - 86_400_000).toISOString(),
        trial_ends_at: null,
        destruction_deadline: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
    ]);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(409);
    expect(fly.listVolumes).not.toHaveBeenCalled();
    expect(fly.deleteVolume).not.toHaveBeenCalled();
  });

  it('allows destroy when the user has only a non-access-granting subscription', async () => {
    const { env } = makeEnv();
    mockDestroyLookup(DEFAULT_DESTROY_ROW, [accessGrantingSubscriptionRow('canceled')]);
    vi.mocked(fly.listVolumes).mockResolvedValue([flyVolume()]);
    vi.mocked(fly.deleteVolume).mockResolvedValue(undefined);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(200);
    expect(fly.deleteVolume).toHaveBeenCalledTimes(1);
  });

  it('destroys from the App DO stored Fly app name when present', async () => {
    const { env } = makeEnv({ appName: 'stored-fly-app' });
    vi.mocked(fly.listVolumes).mockResolvedValue([flyVolume()]);
    vi.mocked(fly.deleteVolume).mockResolvedValue(undefined);

    const response = await platform.request(
      '/admin/orphan-volume-destroy',
      destroyInit(validDestroyBody),
      env
    );
    expect(response.status).toBe(200);
    expect(fly.listVolumes).toHaveBeenCalledWith({
      apiToken: 'test-token',
      appName: 'stored-fly-app',
    });
    expect(fly.deleteVolume).toHaveBeenCalledWith(
      {
        apiToken: 'test-token',
        appName: 'stored-fly-app',
      },
      'vol_orphan0000000000'
    );
    const body = (await response.json()) as { flyApp: string };
    expect(body.flyApp).toBe('stored-fly-app');
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

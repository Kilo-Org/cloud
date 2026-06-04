import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from './platform';
import * as fly from '../fly/client';
import type * as FlyClient from '../fly/client';
import * as flyApps from '../fly/apps';
import type * as FlyApps from '../fly/apps';
import { getActivePersonalInstance } from '../db';
import type * as DbModule from '../db';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock('../fly/client', async () => {
  const actual = await vi.importActual<typeof FlyClient>('../fly/client');
  return { ...actual, listMachines: vi.fn(), listVolumes: vi.fn() };
});

vi.mock('../fly/apps', async () => {
  const actual = await vi.importActual<typeof FlyApps>('../fly/apps');
  return {
    ...actual,
    getApp: vi.fn(),
    appNameFromInstanceId: vi.fn().mockResolvedValue('inst-testapp'),
  };
});

vi.mock('../db', async () => {
  const actual = await vi.importActual<typeof DbModule>('../db');
  return {
    ...actual,
    getWorkerDb: vi.fn(() => ({})),
    getActivePersonalInstance: vi.fn(),
  };
});

const USER_ID = 'user-1';
const INSTANCE_ID = '0ef67a15-64d5-450e-a128-df0f22969ac9';

type Reservation = { instanceId: string; status: string };

function makeEnv(opts?: {
  flyApiToken?: string | null;
  reservations?: Reservation[];
  releaseResult?: unknown;
}) {
  const listAllInstances = vi
    .fn()
    .mockResolvedValue({ entries: [], reservations: opts?.reservations ?? [], migrated: true });
  const adminReleaseStuckReservation = vi
    .fn()
    .mockResolvedValue(opts?.releaseResult ?? { outcome: 'released', previousStatus: 'in_progress' });
  const flyApiToken = opts?.flyApiToken === undefined ? 'test-token' : opts.flyApiToken;
  return {
    env: {
      FLY_API_TOKEN: flyApiToken ?? undefined,
      HYPERDRIVE: { connectionString: 'postgres://test' },
      KILOCLAW_REGISTRY: {
        idFromName: (id: string) => id,
        get: () => ({ listAllInstances, adminReleaseStuckReservation }),
      },
    } as never,
    listAllInstances,
    adminReleaseStuckReservation,
  };
}

function releaseInit() {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: USER_ID, instanceId: INSTANCE_ID }),
  };
}

beforeEach(() => {
  vi.mocked(getActivePersonalInstance).mockReset().mockResolvedValue(null);
  vi.mocked(fly.listMachines).mockReset().mockResolvedValue([]);
  vi.mocked(fly.listVolumes).mockReset().mockResolvedValue([]);
  vi.mocked(flyApps.getApp).mockReset().mockResolvedValue(null);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /provision/release-reservation', () => {
  it('refuses when the reservation backs a live active instance', async () => {
    vi.mocked(getActivePersonalInstance).mockResolvedValue({ id: INSTANCE_ID } as never);
    const { env, adminReleaseStuckReservation } = makeEnv();

    const res = await platform.request('/provision/release-reservation', releaseInit(), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('reservation_active');
    expect(adminReleaseStuckReservation).not.toHaveBeenCalled();
  });

  it('returns 404 when no reservation exists for the instance', async () => {
    const { env } = makeEnv({ reservations: [] });
    const res = await platform.request('/provision/release-reservation', releaseInit(), env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('reservation_not_found');
  });

  it('refuses a non-releasable (completed) reservation', async () => {
    const { env, adminReleaseStuckReservation } = makeEnv({
      reservations: [{ instanceId: INSTANCE_ID, status: 'completed' }],
    });
    const res = await platform.request('/provision/release-reservation', releaseInit(), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('reservation_not_releasable');
    expect(adminReleaseStuckReservation).not.toHaveBeenCalled();
  });

  it('refuses failed_requires_reconciliation when provider resources still exist', async () => {
    vi.mocked(flyApps.getApp).mockResolvedValue({ id: 'app', created_at: 1 } as never);
    vi.mocked(fly.listMachines).mockResolvedValue([{ id: 'm1' } as never]);
    const { env, adminReleaseStuckReservation } = makeEnv({
      reservations: [{ instanceId: INSTANCE_ID, status: 'failed_requires_reconciliation' }],
    });

    const res = await platform.request('/provision/release-reservation', releaseInit(), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('provider_resources_present');
    expect(adminReleaseStuckReservation).not.toHaveBeenCalled();
  });

  it('releases failed_requires_reconciliation when no Fly app remains', async () => {
    vi.mocked(flyApps.getApp).mockResolvedValue(null);
    const { env, adminReleaseStuckReservation } = makeEnv({
      reservations: [{ instanceId: INSTANCE_ID, status: 'failed_requires_reconciliation' }],
      releaseResult: { outcome: 'released', previousStatus: 'failed_requires_reconciliation' },
    });

    const res = await platform.request('/provision/release-reservation', releaseInit(), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      previousStatus: 'failed_requires_reconciliation',
    });
    expect(adminReleaseStuckReservation).toHaveBeenCalledOnce();
  });

  it('returns 503 when FLY_API_TOKEN is missing for a reconciliation release', async () => {
    const { env, adminReleaseStuckReservation } = makeEnv({
      flyApiToken: null,
      reservations: [{ instanceId: INSTANCE_ID, status: 'failed_requires_reconciliation' }],
    });

    const res = await platform.request('/provision/release-reservation', releaseInit(), env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe('provider_check_unavailable');
    expect(adminReleaseStuckReservation).not.toHaveBeenCalled();
  });

  it('maps a still-fresh in_progress reservation to 409 (no Fly check needed)', async () => {
    const { env } = makeEnv({
      reservations: [{ instanceId: INSTANCE_ID, status: 'in_progress' }],
      releaseResult: { outcome: 'in_progress_too_fresh', updatedAt: '2026-06-04T13:54:51.966Z' },
    });

    const res = await platform.request('/provision/release-reservation', releaseInit(), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('reservation_in_progress_active');
    expect(flyApps.getApp).not.toHaveBeenCalled();
  });

  it('releases a stale in_progress reservation', async () => {
    const { env } = makeEnv({
      reservations: [{ instanceId: INSTANCE_ID, status: 'in_progress' }],
      releaseResult: { outcome: 'released', previousStatus: 'in_progress' },
    });

    const res = await platform.request('/provision/release-reservation', releaseInit(), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, previousStatus: 'in_progress' });
  });
});

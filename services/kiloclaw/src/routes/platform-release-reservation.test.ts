import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from './platform';
import { getActivePersonalInstance } from '../db';
import type * as DbModule from '../db';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

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

function makeEnv(opts?: { reservations?: Reservation[]; releaseResult?: unknown }) {
  const listAllInstances = vi
    .fn()
    .mockResolvedValue({ entries: [], reservations: opts?.reservations ?? [], migrated: true });
  const adminReleaseStuckReservation = vi.fn().mockResolvedValue(
    opts?.releaseResult ?? {
      outcome: 'released',
      previousStatus: 'failed_requires_reconciliation',
    }
  );
  return {
    env: {
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

function releaseInit(body?: Record<string, unknown>) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      body ?? { userId: USER_ID, instanceId: INSTANCE_ID, acknowledgeCleanupVerified: true }
    ),
  };
}

beforeEach(() => {
  vi.mocked(getActivePersonalInstance).mockReset().mockResolvedValue(null);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /provision/release-reservation', () => {
  it('rejects a request missing the cleanup acknowledgement', async () => {
    const { env, adminReleaseStuckReservation } = makeEnv({
      reservations: [{ instanceId: INSTANCE_ID, status: 'failed_requires_reconciliation' }],
    });
    const res = await platform.request(
      '/provision/release-reservation',
      releaseInit({ userId: USER_ID, instanceId: INSTANCE_ID }),
      env
    );
    expect(res.status).toBe(400);
    expect(adminReleaseStuckReservation).not.toHaveBeenCalled();
  });

  it('rejects a falsey cleanup acknowledgement', async () => {
    const { env } = makeEnv({
      reservations: [{ instanceId: INSTANCE_ID, status: 'failed_requires_reconciliation' }],
    });
    const res = await platform.request(
      '/provision/release-reservation',
      releaseInit({ userId: USER_ID, instanceId: INSTANCE_ID, acknowledgeCleanupVerified: false }),
      env
    );
    expect(res.status).toBe(400);
  });

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

  it('releases a failed_requires_reconciliation reservation with the validated status', async () => {
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
    expect(adminReleaseStuckReservation).toHaveBeenCalledWith(
      expect.any(String),
      USER_ID,
      INSTANCE_ID,
      'failed_requires_reconciliation',
      'manual_admin_release'
    );
  });

  it('maps a concurrent status change to 409', async () => {
    const { env } = makeEnv({
      reservations: [{ instanceId: INSTANCE_ID, status: 'in_progress' }],
      releaseResult: { outcome: 'status_changed', status: 'completed' },
    });

    const res = await platform.request('/provision/release-reservation', releaseInit(), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('reservation_status_changed');
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

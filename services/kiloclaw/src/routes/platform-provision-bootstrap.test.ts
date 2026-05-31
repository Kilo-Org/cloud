import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '../db';
import type * as ProvisionBootstrapModule from './provision-bootstrap';
import type * as AnalyticsModule from '../utils/analytics';
import type { BeginFreshProvisionResult } from '../durable-objects/kiloclaw-registry';

const {
  mockGetWorkerDb,
  mockBootstrapProvisionedSubscriptionWithFallback,
  mockResolveProvisionEntitlementWithFallback,
  mockWriteEvent,
} = vi.hoisted(() => ({
  mockGetWorkerDb: vi.fn(),
  mockBootstrapProvisionedSubscriptionWithFallback: vi.fn(),
  mockResolveProvisionEntitlementWithFallback: vi.fn(),
  mockWriteEvent: vi.fn<
    (
      env: unknown,
      data: {
        event: string;
        userId?: string;
        instanceId?: string;
      }
    ) => void
  >(),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock('../db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getWorkerDb: mockGetWorkerDb,
    getInstanceById: vi.fn(),
    getInstanceByIdIncludingDestroyed: vi.fn(),
  };
});

vi.mock('./provision-bootstrap', async importOriginal => {
  const actual = await importOriginal<typeof ProvisionBootstrapModule>();
  return {
    ...actual,
    bootstrapProvisionedSubscriptionWithFallback: mockBootstrapProvisionedSubscriptionWithFallback,
    resolveProvisionEntitlementWithFallback: mockResolveProvisionEntitlementWithFallback,
  };
});

vi.mock('../utils/analytics', async importOriginal => {
  const actual = await importOriginal<typeof AnalyticsModule>();
  return {
    ...actual,
    writeEvent: mockWriteEvent,
  };
});

import { platform } from './platform';
import { BootstrapProvisionFallbackError } from './provision-bootstrap';

type SelectBuilder<T> = Promise<T[]> & {
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
};

function createSelectBuilder<T>(rows: T[]): SelectBuilder<T> {
  const builder = Object.assign(Promise.resolve(rows), {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  }) as SelectBuilder<T>;
  builder.from.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  return builder;
}

function createWorkerDb(options?: {
  existingActiveInstance?: { id: string; sandboxId: string; organizationId: string | null };
  activeInstanceReads?: Array<{
    id: string;
    sandboxId: string;
    organizationId: string | null;
  } | null>;
  hasSubscription?: boolean;
}) {
  const txInsertReturningQueue = [[{ id: 'instance-new', sandboxId: 'sandbox-new' }], [], []];
  const updateSets: Array<Record<string, unknown>> = [];
  const existingActiveInstance = options?.existingActiveInstance;
  const activeInstanceReads = [...(options?.activeInstanceReads ?? [])];
  let insertedInstance: {
    id: string;
    userId: string;
    sandboxId: string;
    organizationId: string | null;
    name: string | null;
    inboundEmailEnabled: boolean;
    destroyedAt: string | null;
  } | null = null;

  const createSelectRows = (fields: Record<string, unknown>): Array<Record<string, unknown>> => {
    if ('alias' in fields) {
      return [];
    }

    if ('sandbox_id' in fields) {
      const activeInstance =
        activeInstanceReads.length > 0 ? activeInstanceReads.shift() : existingActiveInstance;
      if (activeInstance) {
        return [
          {
            id: activeInstance.id,
            sandbox_id: activeInstance.sandboxId,
            organization_id: activeInstance.organizationId,
          },
        ];
      }
      return [];
    }

    if (Object.keys(fields).length === 1 && 'id' in fields && options?.hasSubscription) {
      return [{ id: 'subscription-1' }];
    }

    if (!insertedInstance) {
      return [];
    }

    if ('subscription' in fields && 'instance' in fields) {
      return [];
    }

    if ('destroyedAt' in fields) {
      return [
        {
          id: insertedInstance.id,
          userId: insertedInstance.userId,
          sandboxId: insertedInstance.sandboxId,
          organizationId: insertedInstance.organizationId,
          name: insertedInstance.name,
          inboundEmailEnabled: insertedInstance.inboundEmailEnabled,
          destroyedAt: insertedInstance.destroyedAt,
        },
      ];
    }

    if ('id' in fields && 'userId' in fields) {
      return [
        {
          id: insertedInstance.id,
          userId: insertedInstance.userId,
        },
      ];
    }

    return [];
  };

  return {
    updateSets,
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn((fields: Record<string, unknown>) =>
          createSelectBuilder(createSelectRows(fields))
        ),
        insert: vi.fn(() => ({
          values: vi.fn((values: Record<string, unknown>) => {
            if (
              typeof values.id === 'string' &&
              typeof values.user_id === 'string' &&
              typeof values.sandbox_id === 'string'
            ) {
              insertedInstance = {
                id: values.id,
                userId: values.user_id,
                sandboxId: values.sandbox_id,
                organizationId:
                  typeof values.organization_id === 'string' ? values.organization_id : null,
                name: null,
                inboundEmailEnabled: false,
                destroyedAt: null,
              };
            }

            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(async () => txInsertReturningQueue.shift() ?? []),
              })),
            };
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn((values: Record<string, unknown>) => {
            updateSets.push(values);
            if (insertedInstance && typeof values.destroyed_at === 'string') {
              insertedInstance = {
                ...insertedInstance,
                destroyedAt: values.destroyed_at,
              };
            }

            return {
              where: vi.fn(() => ({
                returning: vi.fn(async () =>
                  insertedInstance
                    ? [
                        {
                          id: insertedInstance.id,
                          userId: insertedInstance.userId,
                          sandboxId: insertedInstance.sandboxId,
                          organizationId: insertedInstance.organizationId,
                          name: insertedInstance.name,
                          inboundEmailEnabled: insertedInstance.inboundEmailEnabled,
                        },
                      ]
                    : []
                ),
              })),
            };
          }),
        })),
      };

      return await callback(tx);
    }),
    select: vi.fn((fields: Record<string, unknown>) =>
      createSelectBuilder(createSelectRows(fields))
    ),
  };
}

function makeEnv() {
  const destroy = vi
    .fn<(options?: { reason?: string }) => Promise<{ finalized: boolean } | undefined>>()
    .mockResolvedValue(undefined);
  const allowProvisionReservationReleaseOnFinalize = vi.fn().mockResolvedValue(undefined);
  const provision = vi.fn().mockResolvedValue({ sandboxId: 'sandbox-new' });
  const beginFreshProvision = vi.fn<
    (
      registryKey: string,
      assignedUserId: string,
      instanceId: string,
      doKey: string
    ) => Promise<BeginFreshProvisionResult>
  >(async (_registryKey: string, assignedUserId: string, instanceId: string, doKey: string) => ({
    outcome: 'admitted',
    reservation: {
      instanceId,
      doKey,
      assignedUserId,
      status: 'in_progress',
      startedAt: '2026-05-31T00:00:00.000Z',
      updatedAt: '2026-05-31T00:00:00.000Z',
      completedAt: null,
      failureCode: null,
      resolutionReason: null,
    },
  }));
  const completeFreshProvision = vi.fn().mockResolvedValue(undefined);
  const repairCompletedProvision = vi.fn().mockResolvedValue(true);
  const failFreshProvision = vi.fn().mockResolvedValue(undefined);
  const releaseFreshProvision = vi.fn().mockResolvedValue(undefined);
  const createInstance = vi.fn().mockResolvedValue(undefined);
  const registryStub = {
    beginFreshProvision,
    completeFreshProvision,
    repairCompletedProvision,
    failFreshProvision,
    releaseFreshProvision,
    createInstance,
    listInstances: vi.fn().mockResolvedValue([]),
    destroyInstance: vi.fn().mockResolvedValue(undefined),
  };

  return {
    env: {
      HYPERDRIVE: { connectionString: 'postgresql://fake' },
      KILOCLAW_INSTANCE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ provision, destroy, allowProvisionReservationReleaseOnFinalize })),
      },
      KILOCLAW_REGISTRY: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => registryStub),
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
    destroy,
    allowProvisionReservationReleaseOnFinalize,
    provision,
    beginFreshProvision,
    completeFreshProvision,
    repairCompletedProvision,
    failFreshProvision,
    releaseFreshProvision,
    createInstance,
  };
}

describe('platform provision bootstrap quarantine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProvisionEntitlementWithFallback.mockResolvedValue({
      mode: 'rpc',
      priceVersion: '2026-05-10',
      selfServiceInstanceType: 'perf-1-3',
    });
  });

  it('forwards user location to the instance provision config', async () => {
    const { env, provision } = makeEnv();
    const workerDb = createWorkerDb();
    mockGetWorkerDb.mockReturnValue(workerDb);
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValueOnce({ mode: 'rpc' });

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          provider: 'fly',
          userLocation: 'Amsterdam, North Holland, Netherlands',
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(provision).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        userLocation: 'Amsterdam, North Holland, Netherlands',
      }),
      expect.anything()
    );
  });

  it('admits fresh provisioning before provider work and completes after bootstrap', async () => {
    const { env, beginFreshProvision, provision, completeFreshProvision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValueOnce({ mode: 'rpc' });

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', provider: 'fly' }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(beginFreshProvision).toHaveBeenCalledOnce();
    expect(beginFreshProvision.mock.invocationCallOrder[0]).toBeLessThan(
      provision.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(completeFreshProvision.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockBootstrapProvisionedSubscriptionWithFallback.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('returns a conflict without provider work when fresh admission is already occupied', async () => {
    const { env, beginFreshProvision, provision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());
    beginFreshProvision.mockResolvedValueOnce({
      outcome: 'conflict',
      reservation: {
        instanceId: 'existing-reservation',
        doKey: 'existing-reservation',
        assignedUserId: 'user-1',
        status: 'in_progress',
        startedAt: '2026-05-31T00:00:00.000Z',
        updatedAt: '2026-05-31T00:00:00.000Z',
        completedAt: null,
        failureCode: null,
        resolutionReason: null,
      },
    });

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', provider: 'fly' }),
      },
      env
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'provision_in_progress' });
    expect(provision).not.toHaveBeenCalled();
  });

  it('releases admission without provider work when a subscribed canonical active instance exists', async () => {
    const { env, provision, releaseFreshProvision, repairCompletedProvision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(
      createWorkerDb({
        existingActiveInstance: {
          id: '11111111-1111-4111-8111-111111111111',
          sandboxId: 'ki_11111111111141118111111111111111',
          organizationId: null,
        },
        hasSubscription: true,
      })
    );

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', provider: 'fly' }),
      },
      env
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'instance_already_active' });
    expect(provision).not.toHaveBeenCalled();
    expect(releaseFreshProvision).toHaveBeenCalledWith(
      'user:user-1',
      'user-1',
      expect.any(String),
      'active_instance_exists'
    );
    expect(repairCompletedProvision).toHaveBeenCalledWith(
      'user:user-1',
      'user-1',
      '11111111-1111-4111-8111-111111111111',
      expect.any(String)
    );
  });

  it('does not publish an active row that lacks canonical subscription state', async () => {
    const { env, provision, releaseFreshProvision, repairCompletedProvision, createInstance } =
      makeEnv();
    mockGetWorkerDb.mockReturnValue(
      createWorkerDb({
        existingActiveInstance: {
          id: '11111111-1111-4111-8111-111111111111',
          sandboxId: 'ki_11111111111141118111111111111111',
          organizationId: null,
        },
      })
    );

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', provider: 'fly' }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(provision).not.toHaveBeenCalled();
    expect(releaseFreshProvision).toHaveBeenCalled();
    expect(repairCompletedProvision).not.toHaveBeenCalled();
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('repairs a completed reservation through the dedicated endpoint', async () => {
    const { env, repairCompletedProvision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(
      createWorkerDb({
        existingActiveInstance: {
          id: '11111111-1111-4111-8111-111111111111',
          sandboxId: 'ki_11111111111141118111111111111111',
          organizationId: null,
        },
        hasSubscription: true,
      })
    );

    const response = await platform.request(
      '/provision/repair-reservation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          instanceId: '11111111-1111-4111-8111-111111111111',
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(repairCompletedProvision).toHaveBeenCalledWith(
      'user:user-1',
      'user-1',
      '11111111-1111-4111-8111-111111111111',
      expect.any(String)
    );
  });

  it('repairs Registry completion before returning a successful fresh provision', async () => {
    const { env, completeFreshProvision, repairCompletedProvision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValueOnce({ mode: 'rpc' });
    completeFreshProvision.mockRejectedValueOnce(new Error('completion unavailable'));

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', provider: 'fly' }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(repairCompletedProvision).toHaveBeenCalledOnce();
  });

  it('returns a pending-finalization response when completion and repair both fail', async () => {
    const { env, completeFreshProvision, repairCompletedProvision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValueOnce({ mode: 'rpc' });
    completeFreshProvision.mockRejectedValueOnce(new Error('completion unavailable'));
    repairCompletedProvision.mockRejectedValueOnce(new Error('repair unavailable'));

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', provider: 'fly' }),
      },
      env
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'provision_completion_pending' });
  });

  it('returns an error and authorizes release after Postgres quarantine succeeds', async () => {
    const { env, destroy, failFreshProvision, allowProvisionReservationReleaseOnFinalize } =
      makeEnv();
    const workerDb = createWorkerDb();
    mockGetWorkerDb.mockReturnValue(workerDb);
    mockBootstrapProvisionedSubscriptionWithFallback.mockRejectedValueOnce(
      new BootstrapProvisionFallbackError({
        rpcError: new Error('rpc down'),
        fallbackError: new Error('fallback down'),
      })
    );

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          provider: 'fly',
        }),
      },
      env
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'post-provision bootstrap failed',
    });
    expect(destroy).toHaveBeenCalledWith({ reason: 'bootstrap_cleanup_failure' });
    const destroyUpdate = workerDb.updateSets.find(
      update => typeof update.destroyed_at === 'string'
    );
    expect(destroyUpdate?.destroyed_at).toBeDefined();
    const eventCall = mockWriteEvent.mock.calls.find(
      call => call[1]?.event === 'instance.subscription_bootstrap_quarantined'
    );
    expect(eventCall?.[0]).toBe(env);
    expect(eventCall?.[1]?.event).toBe('instance.subscription_bootstrap_quarantined');
    expect(eventCall?.[1]?.userId).toBe('user-1');
    expect(typeof eventCall?.[1]?.instanceId).toBe('string');
    expect(eventCall?.[1]?.instanceId?.length).toBeGreaterThan(0);
    expect(allowProvisionReservationReleaseOnFinalize).toHaveBeenCalledOnce();
    expect(failFreshProvision).not.toHaveBeenCalled();
  });

  it('delegates finalized bootstrap cleanup release to the instance DO', async () => {
    const { env, destroy, allowProvisionReservationReleaseOnFinalize, failFreshProvision } =
      makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());
    destroy.mockResolvedValueOnce({ finalized: true });
    mockBootstrapProvisionedSubscriptionWithFallback.mockRejectedValueOnce(
      new BootstrapProvisionFallbackError({
        rpcError: new Error('rpc down'),
        fallbackError: new Error('fallback down'),
      })
    );

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', provider: 'fly' }),
      },
      env
    );

    expect(response.status).toBe(500);
    expect(allowProvisionReservationReleaseOnFinalize).toHaveBeenCalledOnce();
    expect(failFreshProvision).not.toHaveBeenCalled();
  });

  it('surfaces bootstrap-time organization entitlement loss and tears down new infrastructure', async () => {
    const { env, destroy } = makeEnv();
    const workerDb = createWorkerDb();
    mockGetWorkerDb.mockReturnValue(workerDb);
    mockBootstrapProvisionedSubscriptionWithFallback.mockRejectedValueOnce(
      new BootstrapProvisionFallbackError({
        rpcError: new Error('rpc saw stale organization state'),
        fallbackError: Object.assign(new Error('Organization KiloClaw entitlement has expired.'), {
          status: 403,
        }),
      })
    );

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          orgId: '22222222-2222-4222-8222-222222222222',
          provider: 'fly',
        }),
      },
      env
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Organization KiloClaw entitlement has expired.',
    });
    expect(destroy).toHaveBeenCalledWith({ reason: 'bootstrap_cleanup_failure' });
    const destroyUpdate = workerDb.updateSets.find(
      update => typeof update.destroyed_at === 'string'
    );
    expect(destroyUpdate?.destroyed_at).toBeDefined();
  });
});

describe('platform /provision: instanceType defaulting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProvisionEntitlementWithFallback.mockResolvedValue({
      mode: 'rpc',
      priceVersion: '2026-05-10',
      selfServiceInstanceType: 'perf-1-3',
    });
  });

  it('defaults instanceType from the billing entitlement preflight on FRESH insert when caller omits it', async () => {
    const { env, provision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());
    mockResolveProvisionEntitlementWithFallback.mockResolvedValueOnce({
      mode: 'rpc',
      priceVersion: '2026-05-10',
      selfServiceInstanceType: 'perf-1-3',
    });
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValueOnce({ mode: 'rpc' });

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          provider: 'fly',
          // No instanceId — fresh insert.
          // No instanceType — caller wants the default.
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(mockResolveProvisionEntitlementWithFallback).toHaveBeenCalledWith({
      env,
      input: { userId: 'user-1', orgId: null },
    });
    expect(provision).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ instanceType: 'perf-1-3' }),
      expect.anything()
    );
    expect(mockBootstrapProvisionedSubscriptionWithFallback).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(mockBootstrapProvisionedSubscriptionWithFallback.mock.calls[0]?.[0])
    ).toContain('"expectedPriceVersion":"2026-05-10"');
  });

  it('rejects current fresh self-service provisioning above the billing entitlement cap', async () => {
    const { env, provision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());
    mockResolveProvisionEntitlementWithFallback.mockResolvedValue({
      mode: 'rpc',
      priceVersion: '2026-05-10',
      selfServiceInstanceType: 'perf-1-3',
    });
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValue({ mode: 'rpc' });

    for (const instanceType of ['perf-4-8', 'perf-4-16']) {
      const response = await platform.request(
        '/provision',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userId: 'user-1',
            provider: 'fly',
            instanceType,
          }),
        },
        env
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'instanceType exceeds self-service entitlement',
      });
    }

    expect(provision).not.toHaveBeenCalled();
    expect(mockBootstrapProvisionedSubscriptionWithFallback).not.toHaveBeenCalled();
  });

  it('uses the canonical perf entitlement tier for live legacy successor provisioning', async () => {
    const { env, provision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());
    mockResolveProvisionEntitlementWithFallback.mockResolvedValueOnce({
      mode: 'rpc',
      priceVersion: '2026-03-19',
      selfServiceInstanceType: 'perf-1-3',
    });
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValueOnce({ mode: 'rpc' });

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          provider: 'fly',
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(provision).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ instanceType: 'perf-1-3' }),
      expect.anything()
    );
    expect(mockBootstrapProvisionedSubscriptionWithFallback).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(mockBootstrapProvisionedSubscriptionWithFallback.mock.calls[0]?.[0])
    ).toContain('"expectedPriceVersion":"2026-03-19"');
  });

  it('rejects legacy fresh self-service provisioning above the billing entitlement cap', async () => {
    const { env, provision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());
    mockResolveProvisionEntitlementWithFallback.mockResolvedValue({
      mode: 'rpc',
      priceVersion: '2026-03-19',
      selfServiceInstanceType: 'perf-1-3',
    });
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValue({ mode: 'rpc' });

    for (const instanceType of ['perf-4-8', 'perf-4-16']) {
      const response = await platform.request(
        '/provision',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userId: 'user-1',
            provider: 'fly',
            instanceType,
          }),
        },
        env
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'instanceType exceeds self-service entitlement',
      });
    }

    expect(provision).not.toHaveBeenCalled();
    expect(mockBootstrapProvisionedSubscriptionWithFallback).not.toHaveBeenCalled();
  });

  it('surfaces organization entitlement denial before provisioning infrastructure', async () => {
    const { env, provision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());
    mockResolveProvisionEntitlementWithFallback.mockRejectedValueOnce(
      Object.assign(new Error('Organization KiloClaw entitlement has expired.'), { status: 403 })
    );
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValue({ mode: 'rpc' });

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          orgId: '22222222-2222-4222-8222-222222222222',
          provider: 'fly',
        }),
      },
      env
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Organization KiloClaw entitlement has expired.',
    });
    expect(provision).not.toHaveBeenCalled();
    expect(mockBootstrapProvisionedSubscriptionWithFallback).not.toHaveBeenCalled();
  });

  it('fails closed before provisioning when entitlement or price version cannot be resolved', async () => {
    const scenarios = [
      {
        name: 'entitlement lookup failure',
        arrange: () =>
          mockResolveProvisionEntitlementWithFallback.mockRejectedValueOnce(
            new Error('billing down')
          ),
      },
      {
        name: 'unknown price version',
        arrange: () =>
          mockResolveProvisionEntitlementWithFallback.mockResolvedValueOnce({
            mode: 'rpc',
            priceVersion: '2099-01-01',
            selfServiceInstanceType: 'perf-1-3',
          }),
      },
    ];

    for (const scenario of scenarios) {
      vi.clearAllMocks();
      const { env, provision } = makeEnv();
      mockGetWorkerDb.mockReturnValue(createWorkerDb());
      mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValue({ mode: 'rpc' });
      scenario.arrange();

      const response = await platform.request(
        '/provision',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userId: 'user-1',
            provider: 'fly',
          }),
        },
        env
      );

      expect(response.status, scenario.name).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'provision failed' });
      expect(provision, scenario.name).not.toHaveBeenCalled();
      expect(
        mockBootstrapProvisionedSubscriptionWithFallback,
        scenario.name
      ).not.toHaveBeenCalled();
    }
  });

  it('fails closed before provisioning when entitlement tier disagrees with the price-version catalog', async () => {
    const { env, provision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());
    mockResolveProvisionEntitlementWithFallback.mockResolvedValueOnce({
      mode: 'rpc',
      priceVersion: '2026-03-19',
      selfServiceInstanceType: 'shared-2-3',
    });
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValue({ mode: 'rpc' });

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          provider: 'fly',
        }),
      },
      env
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'provision failed' });
    expect(provision).not.toHaveBeenCalled();
    expect(mockBootstrapProvisionedSubscriptionWithFallback).not.toHaveBeenCalled();
  });

  it('passes instanceType=undefined to the DO on RE-PROVISION (instanceId provided, no tier)', async () => {
    // Regression for the silent-clobber bug: provision() is overloaded as the
    // entrypoint for config-update flows on existing instances. The DO's
    // `inferredInstanceType` path preserves existing tier / machineSize /
    // volumeSizeGb when `config.instanceType` is undefined; defaulting to
    // perf-1-3 unconditionally would silently overwrite custom (e.g.
    // extend-volume) and legacy tiers on the next config change.
    const { env, provision, beginFreshProvision, repairCompletedProvision } = makeEnv();
    const existingInstanceId = '11111111-1111-4111-8111-111111111111';
    mockGetWorkerDb.mockReturnValue(
      createWorkerDb({
        existingActiveInstance: {
          id: existingInstanceId,
          sandboxId: 'ki_11111111111141118111111111111111',
          organizationId: null,
        },
        hasSubscription: true,
      })
    );
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValueOnce({ mode: 'rpc' });

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          provider: 'fly',
          instanceId: existingInstanceId, // re-provision — existing instance
          // No instanceType — caller wants existing tier preserved.
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(beginFreshProvision).not.toHaveBeenCalled();
    expect(repairCompletedProvision).toHaveBeenCalledWith(
      'user:user-1',
      'user-1',
      existingInstanceId,
      expect.any(String)
    );
    const provisionConfig = provision.mock.calls[0][1] as Record<string, unknown>;
    expect(provisionConfig.instanceType).toBeUndefined();
  });

  it('fails closed before mutation when an existing-instance repair cannot be confirmed', async () => {
    const { env, repairCompletedProvision, provision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(
      createWorkerDb({
        existingActiveInstance: {
          id: '11111111-1111-4111-8111-111111111111',
          sandboxId: 'ki_11111111111141118111111111111111',
          organizationId: null,
        },
        hasSubscription: true,
      })
    );
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValueOnce({ mode: 'rpc' });
    repairCompletedProvision.mockRejectedValueOnce(new Error('registry unavailable'));

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          instanceId: '11111111-1111-4111-8111-111111111111',
        }),
      },
      env
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'provision_completion_pending' });
    expect(provision).not.toHaveBeenCalled();
  });

  it('does not republish an existing instance after destroy wins during its update', async () => {
    const { env, provision, createInstance } = makeEnv();
    const existing = {
      id: '11111111-1111-4111-8111-111111111111',
      sandboxId: 'ki_11111111111141118111111111111111',
      organizationId: null,
    };
    mockGetWorkerDb.mockReturnValue(
      createWorkerDb({ activeInstanceReads: [existing, null], hasSubscription: true })
    );

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', instanceId: existing.id }),
      },
      env
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'instance_destroyed' });
    expect(provision).toHaveBeenCalledOnce();
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary instanceId before provider work', async () => {
    const { env, provision, beginFreshProvision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          instanceId: '11111111-1111-4111-8111-111111111111',
        }),
      },
      env
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'instance_not_found' });
    expect(provision).not.toHaveBeenCalled();
    expect(beginFreshProvision).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary organization instanceId before provider work', async () => {
    const { env, provision, beginFreshProvision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(createWorkerDb());

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          orgId: '22222222-2222-4222-8222-222222222222',
          instanceId: '11111111-1111-4111-8111-111111111111',
        }),
      },
      env
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'instance_not_found' });
    expect(provision).not.toHaveBeenCalled();
    expect(beginFreshProvision).not.toHaveBeenCalled();
  });

  it('recovers an unpaired explicit instance only through subscription bootstrap', async () => {
    const { env, provision, repairCompletedProvision } = makeEnv();
    repairCompletedProvision.mockResolvedValueOnce(true);
    mockGetWorkerDb.mockReturnValue(
      createWorkerDb({
        existingActiveInstance: {
          id: '11111111-1111-4111-8111-111111111111',
          sandboxId: 'ki_11111111111141118111111111111111',
          organizationId: null,
        },
      })
    );
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValueOnce({ mode: 'rpc' });

    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          instanceId: '11111111-1111-4111-8111-111111111111',
          bootstrapSubscription: true,
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(provision).toHaveBeenCalledOnce();
    expect(mockBootstrapProvisionedSubscriptionWithFallback).toHaveBeenCalledOnce();
    expect(repairCompletedProvision).toHaveBeenCalledWith(
      'user:user-1',
      'user-1',
      '11111111-1111-4111-8111-111111111111',
      expect.any(String)
    );
  });

  it('honors caller-supplied instanceType on RE-PROVISION', async () => {
    const { env, provision } = makeEnv();
    mockGetWorkerDb.mockReturnValue(
      createWorkerDb({
        existingActiveInstance: {
          id: '11111111-1111-4111-8111-111111111111',
          sandboxId: 'ki_11111111111141118111111111111111',
          organizationId: null,
        },
        hasSubscription: true,
      })
    );
    mockBootstrapProvisionedSubscriptionWithFallback.mockResolvedValueOnce({ mode: 'rpc' });

    const existingInstanceId = '11111111-1111-4111-8111-111111111111';
    const response = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          provider: 'fly',
          instanceId: existingInstanceId,
          instanceType: 'perf-4-8',
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(provision).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ instanceType: 'perf-4-8' }),
      expect.anything()
    );
  });
});

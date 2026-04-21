import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '../db';
import type * as ProvisionBootstrapModule from './provision-bootstrap';
import type * as AnalyticsModule from '../utils/analytics';

const { mockGetWorkerDb, mockBootstrapProvisionedSubscriptionWithFallback, mockWriteEvent } =
  vi.hoisted(() => ({
    mockGetWorkerDb: vi.fn(),
    mockBootstrapProvisionedSubscriptionWithFallback: vi.fn(),
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
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
};

function createSelectBuilder<T>(rows: T[]): SelectBuilder<T> {
  const builder = Object.assign(Promise.resolve(rows), {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  }) as SelectBuilder<T>;
  builder.from.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  return builder;
}

function createWorkerDb() {
  const txInsertReturningQueue = [[{ id: 'instance-new', sandboxId: 'sandbox-new' }], [], []];
  const updateSets: Array<Record<string, unknown>> = [];
  let insertedInstance: {
    id: string;
    userId: string;
    sandboxId: string;
    organizationId: string | null;
    name: string | null;
    inboundEmailEnabled: boolean;
    destroyedAt: string | null;
  } | null = null;

  const createSelectRows = (fields: Record<string, unknown>) => {
    if ('alias' in fields) {
      return [];
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
    select: vi.fn(() => createSelectBuilder([])),
  };
}

function makeEnv() {
  const destroy = vi.fn().mockResolvedValue(undefined);
  const provision = vi.fn().mockResolvedValue({ sandboxId: 'sandbox-new' });

  return {
    env: {
      HYPERDRIVE: { connectionString: 'postgresql://fake' },
      KILOCLAW_INSTANCE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ provision, destroy })),
      },
      KILOCLAW_REGISTRY: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          createInstance: vi.fn().mockResolvedValue(undefined),
          listInstances: vi.fn().mockResolvedValue([]),
          destroyInstance: vi.fn().mockResolvedValue(undefined),
        })),
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
    provision,
  };
}

describe('platform provision bootstrap quarantine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('returns an error and marks fresh instance destroyed when RPC and fallback both fail', async () => {
    const { env, destroy } = makeEnv();
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
    expect(destroy).not.toHaveBeenCalled();
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
  });
});

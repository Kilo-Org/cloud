import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '@kilocode/db';
import type { BootstrapProvisionFallbackError } from './provision-bootstrap';

const { mockGetWorkerDb, mockBootstrapProvisionSubscriptionWithDb } = vi.hoisted(() => ({
  mockGetWorkerDb: vi.fn(),
  mockBootstrapProvisionSubscriptionWithDb: vi.fn<
    (params: {
      db: unknown;
      input: {
        userId: string;
        instanceId: string;
        orgId: string | null;
      };
      actor: {
        actorType: 'system';
        actorId: string;
      };
    }) => Promise<{ id: string }>
  >(),
}));

vi.mock('@kilocode/db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getWorkerDb: mockGetWorkerDb,
  };
});

vi.mock('../../../kiloclaw-billing/src/provision-bootstrap-shared.js', () => ({
  bootstrapProvisionSubscriptionWithDb: mockBootstrapProvisionSubscriptionWithDb,
}));

import {
  bootstrapProvisionedSubscriptionLocally,
  bootstrapProvisionedSubscriptionWithFallback,
} from './provision-bootstrap';

describe('bootstrapProvisionedSubscriptionWithFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to local bootstrap when billing RPC fails', async () => {
    const db = { fake: true };
    mockGetWorkerDb.mockReturnValue(db);
    mockBootstrapProvisionSubscriptionWithDb.mockResolvedValue({ id: 'sub-local' });

    const env = {
      HYPERDRIVE: { connectionString: 'postgresql://fake' },
      KILOCLAW_BILLING: {
        bootstrapProvisionSubscription: vi.fn().mockRejectedValue(new Error('rpc down')),
      },
    } as never;

    await expect(
      bootstrapProvisionedSubscriptionWithFallback({
        env,
        input: {
          userId: 'user-1',
          instanceId: '11111111-1111-4111-8111-111111111111',
          orgId: null,
        },
      })
    ).resolves.toEqual({
      subscriptionId: 'sub-local',
      mode: 'local_fallback',
    });

    expect(mockGetWorkerDb).toHaveBeenCalledWith('postgresql://fake');
    const call = mockBootstrapProvisionSubscriptionWithDb.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call?.db).toBe(db);
    expect(call?.input).toEqual({
      userId: 'user-1',
      instanceId: '11111111-1111-4111-8111-111111111111',
      orgId: null,
    });
    expect(call?.actor).toEqual({
      actorType: 'system',
      actorId: 'kiloclaw-platform-bootstrap',
    });
  });

  it('surfaces both errors when RPC and local fallback fail', async () => {
    const rpcError = new Error('rpc down');
    const fallbackError = new Error('db down');
    mockGetWorkerDb.mockReturnValue({ fake: true });
    mockBootstrapProvisionSubscriptionWithDb.mockRejectedValue(fallbackError);

    const env = {
      HYPERDRIVE: { connectionString: 'postgresql://fake' },
      KILOCLAW_BILLING: {
        bootstrapProvisionSubscription: vi.fn().mockRejectedValue(rpcError),
      },
    } as never;

    await expect(
      bootstrapProvisionedSubscriptionWithFallback({
        env,
        input: {
          userId: 'user-1',
          instanceId: '11111111-1111-4111-8111-111111111111',
          orgId: null,
        },
      })
    ).rejects.toMatchObject({
      name: 'BootstrapProvisionFallbackError',
      rpcError,
      fallbackError,
    } satisfies Partial<BootstrapProvisionFallbackError>);
  });

  it('bootstraps locally when called directly', async () => {
    mockGetWorkerDb.mockReturnValue({ fake: true });
    mockBootstrapProvisionSubscriptionWithDb.mockResolvedValue({ id: 'sub-local' });

    await expect(
      bootstrapProvisionedSubscriptionLocally({
        env: {
          HYPERDRIVE: { connectionString: 'postgresql://fake' },
        } as never,
        input: {
          userId: 'user-1',
          instanceId: '11111111-1111-4111-8111-111111111111',
          orgId: null,
        },
      })
    ).resolves.toEqual({ subscriptionId: 'sub-local' });
  });
});

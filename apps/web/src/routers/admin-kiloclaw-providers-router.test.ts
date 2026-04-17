import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanupDbForTest } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { createCallerForUser as createCallerForUserType } from '@/routers/test-utils';
import type { User } from '@kilocode/db/schema';

type KiloClawClientMock = {
  KiloClawInternalClient: jest.Mock;
  __getProviderRolloutMock: jest.MockedFunction<() => Promise<unknown>>;
  __updateProviderRolloutMock: jest.MockedFunction<(input: unknown) => Promise<unknown>>;
};

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const getProviderRolloutMock = jest.fn();
  const updateProviderRolloutMock = jest.fn();
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      getProviderRollout: getProviderRolloutMock,
      updateProviderRollout: updateProviderRolloutMock,
    })),
    KiloClawApiError: class KiloClawApiError extends Error {
      statusCode: number;
      responseBody: string;
      constructor(statusCode: number, responseBody: string) {
        super(`KiloClawApiError: ${statusCode}`);
        this.statusCode = statusCode;
        this.responseBody = responseBody;
      }
    },
    __getProviderRolloutMock: getProviderRolloutMock,
    __updateProviderRolloutMock: updateProviderRolloutMock,
  };
});

const kiloclawClientMock = jest.requireMock<KiloClawClientMock>(
  '@/lib/kiloclaw/kiloclaw-internal-client'
);

let createCallerForUser: typeof createCallerForUserType;
let adminUser: User;
let nonAdminUser: User;

beforeAll(async () => {
  ({ createCallerForUser } = await import('@/routers/test-utils'));
});

describe('admin KiloClaw provider rollout router', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawClientMock.KiloClawInternalClient.mockClear();
    kiloclawClientMock.__getProviderRolloutMock.mockReset();
    kiloclawClientMock.__updateProviderRolloutMock.mockReset();
    adminUser = await insertTestUser({
      google_user_email: 'admin-kiloclaw-providers@admin.example.com',
      google_user_name: 'Admin KiloClaw Provider User',
      is_admin: true,
    });
    nonAdminUser = await insertTestUser({
      google_user_email: 'non-admin-kiloclaw-providers@example.com',
      google_user_name: 'Non Admin KiloClaw Provider User',
      is_admin: false,
    });
  });

  it('returns provider rollout config from the Worker', async () => {
    kiloclawClientMock.__getProviderRolloutMock.mockResolvedValue({
      rollout: {
        northflank: {
          personalTrafficPercent: 0,
          organizationTrafficPercent: 0,
          enabledOrganizationIds: [],
        },
      },
      availability: { northflank: false },
      source: 'default',
    });
    const caller = await createCallerForUser(adminUser.id);

    await expect(caller.admin.kiloclawProviders.getRollout()).resolves.toEqual({
      rollout: {
        northflank: {
          personalTrafficPercent: 0,
          organizationTrafficPercent: 0,
          enabledOrganizationIds: [],
        },
      },
      availability: { northflank: false },
      source: 'default',
    });
  });

  it('updates provider rollout config through the Worker', async () => {
    const input = {
      northflank: {
        personalTrafficPercent: 10,
        organizationTrafficPercent: 25,
        enabledOrganizationIds: ['550e8400-e29b-41d4-a716-446655440001'],
      },
    };
    kiloclawClientMock.__updateProviderRolloutMock.mockResolvedValue({
      ok: true,
      rollout: input,
      availability: { northflank: false },
    });
    const caller = await createCallerForUser(adminUser.id);

    await caller.admin.kiloclawProviders.updateRollout(input);

    expect(kiloclawClientMock.__updateProviderRolloutMock).toHaveBeenCalledWith(input);
  });

  it('rejects invalid traffic percentages', async () => {
    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.kiloclawProviders.updateRollout({
        northflank: {
          personalTrafficPercent: 101,
          organizationTrafficPercent: 25,
          enabledOrganizationIds: [],
        },
      })
    ).rejects.toThrow();
  });

  it('rejects non-admin users', async () => {
    const caller = await createCallerForUser(nonAdminUser.id);

    await expect(caller.admin.kiloclawProviders.getRollout()).rejects.toThrow();
  });
});

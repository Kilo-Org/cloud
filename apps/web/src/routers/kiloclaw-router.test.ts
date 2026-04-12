process.env.STRIPE_KILOCLAW_COMMIT_PRICE_ID ||= 'price_commit';
process.env.STRIPE_KILOCLAW_STANDARD_PRICE_ID ||= 'price_standard';
process.env.STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID ||= 'price_standard_intro';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createCallerFactory } from '@/lib/trpc/init';
import { kiloclawRouter } from '@/routers/kiloclaw-router';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kiloclaw_cli_runs, kiloclaw_instances } from '@kilocode/db/schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

type KiloClawClientMock = {
  KiloClawInternalClient: AnyMock;
  __getStatusMock: AnyMock;
};

jest.mock('@/lib/stripe-client', () => {
  const stripeMock = {
    subscriptions: { retrieve: jest.fn(), update: jest.fn(), list: jest.fn() },
    subscriptionSchedules: {
      create: jest.fn(),
      update: jest.fn(),
      release: jest.fn(),
      retrieve: jest.fn(),
    },
    checkout: { sessions: { create: jest.fn(), list: jest.fn(), expire: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
    invoices: { list: jest.fn() },
  };
  return { client: stripeMock };
});

jest.mock('@/lib/kiloclaw/stripe-price-ids.server', () => ({
  getStripePriceIdForClawPlan: jest.fn(() => 'price_test_kiloclaw'),
  getStripePriceIdForClawPlanIntro: jest.fn((plan: string) =>
    plan === 'standard' ? 'price_standard_intro' : 'price_commit'
  ),
  getClawPlanForStripePriceId: jest.fn((priceId: string) => {
    if (priceId === 'price_commit') return 'commit';
    if (priceId === 'price_standard') return 'standard';
    if (priceId === 'price_standard_intro') return 'standard';
    return null;
  }),
  isIntroPriceId: jest.fn((priceId: string) => priceId === 'price_standard_intro'),
}));

jest.mock('next/headers', () => {
  const fn = jest.fn as (...args: unknown[]) => AnyMock;
  return {
    cookies: fn().mockResolvedValue({ get: fn() }),
    headers: fn().mockReturnValue(new Map()),
  };
});

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const getStatusMock = jest.fn();
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      getStatus: getStatusMock,
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
    __getStatusMock: getStatusMock,
  };
});

const createCaller = createCallerFactory(kiloclawRouter);
const kiloclawClientMock = jest.requireMock<KiloClawClientMock>(
  '@/lib/kiloclaw/kiloclaw-internal-client'
);

function sandboxId(): string {
  return `ki_${crypto.randomUUID().replace(/-/g, '')}`;
}

describe('kiloclawRouter getStatus', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawClientMock.KiloClawInternalClient.mockClear();
    kiloclawClientMock.__getStatusMock.mockReset();
  });

  it('returns a no-instance sentinel without querying the legacy worker path', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-status-test-${Math.random()}@example.com`,
    });
    const caller = createCaller({ user });

    const result = await caller.getStatus();

    expect(kiloclawClientMock.KiloClawInternalClient).not.toHaveBeenCalled();
    expect(kiloclawClientMock.__getStatusMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      userId: user.id,
      sandboxId: null,
      status: null,
      provisionedAt: null,
      lastStartedAt: null,
      lastStoppedAt: null,
      envVarCount: 0,
      secretCount: 0,
      channelCount: 0,
      flyAppName: null,
      flyMachineId: null,
      flyVolumeId: null,
      flyRegion: null,
      machineSize: null,
      openclawVersion: null,
      imageVariant: null,
      trackedImageTag: null,
      trackedImageDigest: null,
      googleConnected: false,
      gmailNotificationsEnabled: false,
      execSecurity: null,
      execAsk: null,
      botName: null,
      botNature: null,
      botVibe: null,
      botEmoji: null,
      workerUrl: 'https://claw.kilo.ai',
      name: null,
      instanceId: null,
    });
  });
});

describe('kiloclawRouter listKiloCliRuns', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('returns only runs for the active personal instance when one exists', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-cli-runs-${Math.random()}@example.com`,
    });

    const [destroyedInstance, activeInstance] = await db
      .insert(kiloclaw_instances)
      .values([
        {
          user_id: user.id,
          sandbox_id: sandboxId(),
          destroyed_at: '2026-04-01T00:00:00.000Z',
        },
        {
          user_id: user.id,
          sandbox_id: sandboxId(),
        },
      ])
      .returning({ id: kiloclaw_instances.id });

    if (!destroyedInstance || !activeInstance) {
      throw new Error('Failed to create KiloClaw test instances');
    }

    await db.insert(kiloclaw_cli_runs).values([
      {
        user_id: user.id,
        instance_id: destroyedInstance.id,
        prompt: 'destroyed instance run',
        status: 'completed',
        started_at: '2026-04-01T00:00:00.000Z',
      },
      {
        user_id: user.id,
        instance_id: activeInstance.id,
        prompt: 'active instance run',
        status: 'completed',
        started_at: '2026-04-03T00:00:00.000Z',
      },
      {
        user_id: user.id,
        instance_id: null,
        prompt: 'legacy null instance run',
        status: 'completed',
        started_at: '2026-04-05T00:00:00.000Z',
      },
    ]);

    const caller = createCaller({ user });
    const result = await caller.listKiloCliRuns();

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.prompt).toBe('active instance run');
    expect(result.runs[0]?.instance_id).toBe(activeInstance.id);
  });

  it('preserves user-scoped listing when no active personal instance exists', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-cli-runs-legacy-${Math.random()}@example.com`,
    });

    const [destroyedInstance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: sandboxId(),
        destroyed_at: '2026-04-01T00:00:00.000Z',
      })
      .returning({ id: kiloclaw_instances.id });

    if (!destroyedInstance) {
      throw new Error('Failed to create KiloClaw test instance');
    }

    await db.insert(kiloclaw_cli_runs).values([
      {
        user_id: user.id,
        instance_id: destroyedInstance.id,
        prompt: 'destroyed instance run',
        status: 'completed',
        started_at: '2026-04-01T00:00:00.000Z',
      },
      {
        user_id: user.id,
        instance_id: null,
        prompt: 'legacy null instance run',
        status: 'completed',
        started_at: '2026-04-02T00:00:00.000Z',
      },
    ]);

    const caller = createCaller({ user });
    const result = await caller.listKiloCliRuns();

    expect(result.runs.map(run => run.prompt)).toEqual([
      'legacy null instance run',
      'destroyed instance run',
    ]);
  });
});

process.env.STRIPE_KILOCLAW_COMMIT_PRICE_ID ||= 'price_commit';
process.env.STRIPE_KILOCLAW_STANDARD_PRICE_ID ||= 'price_standard';
process.env.STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID ||= 'price_standard_intro';

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createCallerFactory } from '@/lib/trpc/init';
import { ensureActiveInstance } from '@/lib/kiloclaw/instance-registry';
import { updateKiloClawProviderRolloutConfig } from '@/lib/kiloclaw/provider-rollout-config';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { kiloclawRouter } from '@/routers/kiloclaw-router';
import type { User } from '@kilocode/db/schema';
import {
  kiloclaw_inbound_email_aliases,
  kiloclaw_inbound_email_reserved_aliases,
  kiloclaw_instances,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

jest.setTimeout(30_000);

type KiloClawClientMock = {
  KiloClawInternalClient: AnyMock;
  __getStatusMock: AnyMock;
  __provisionMock: AnyMock;
};

type KiloClawRouterInputs = inferRouterInputs<typeof kiloclawRouter>;
type KiloClawRouterOutputs = inferRouterOutputs<typeof kiloclawRouter>;
type KiloClawCaller = {
  provision(input: KiloClawRouterInputs['provision']): Promise<KiloClawRouterOutputs['provision']>;
  getStatus(): Promise<KiloClawRouterOutputs['getStatus']>;
  cycleInboundEmailAddress(): Promise<KiloClawRouterOutputs['cycleInboundEmailAddress']>;
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
  const provisionMock = jest.fn();
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      getStatus: getStatusMock,
      provision: provisionMock,
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
    __provisionMock: provisionMock,
  };
});

let createCaller: (ctx: { user: User }) => KiloClawCaller;
let kiloclawClientMock: KiloClawClientMock;

beforeAll(async () => {
  const [{ kiloclawRouter }, clientMock] = await Promise.all([
    import('@/routers/kiloclaw-router'),
    import('@/lib/kiloclaw/kiloclaw-internal-client'),
  ]);
  const callerFactory = createCallerFactory(kiloclawRouter);
  createCaller = ctx => callerFactory(ctx) as KiloClawCaller;
  kiloclawClientMock = jest.mocked(clientMock as unknown as KiloClawClientMock);
});

describe('kiloclawRouter getStatus', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawClientMock.KiloClawInternalClient.mockClear();
    kiloclawClientMock.__getStatusMock.mockReset();
    kiloclawClientMock.__provisionMock.mockReset();
  });

  it('provisions Fly by default and stores the provider on the instance row', async () => {
    kiloclawClientMock.__provisionMock.mockResolvedValue({ ok: true });
    const user = await insertTestUser({
      google_user_email: `kiloclaw-provision-test-${Math.random()}@example.com`,
    });
    const caller = createCaller({ user });

    await caller.provision({});

    const [instance] = await db
      .select({ provider: kiloclaw_instances.provider })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.user_id, user.id));

    expect(instance).toBeDefined();
    if (!instance) throw new Error('Expected instance row');
    expect(instance.provider).toBe('fly');
    expect(kiloclawClientMock.__provisionMock).toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({ provider: 'fly' }),
      expect.objectContaining({ instanceId: expect.any(String) })
    );
  });

  it('selects Northflank for new personal rows when DB rollout enables it', async () => {
    await updateKiloClawProviderRolloutConfig({
      provider: 'northflank',
      enabled: true,
      personalTrafficPercent: 100,
      organizationTrafficPercent: 0,
    });
    kiloclawClientMock.__provisionMock.mockResolvedValue({ ok: true });
    const user = await insertTestUser({
      google_user_email: `kiloclaw-northflank-test-${Math.random()}@example.com`,
    });
    const caller = createCaller({ user });

    await caller.provision({});

    const [instance] = await db
      .select({ provider: kiloclaw_instances.provider })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.user_id, user.id));

    expect(instance).toBeDefined();
    if (!instance) throw new Error('Expected instance row');
    expect(instance.provider).toBe('northflank');
    expect(kiloclawClientMock.__provisionMock).toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({ provider: 'northflank' }),
      expect.objectContaining({ instanceId: expect.any(String) })
    );
  });

  it('passes the persisted provider for a pre-created personal instance row', async () => {
    kiloclawClientMock.__provisionMock.mockResolvedValue({ ok: true });
    const user = await insertTestUser({
      google_user_email: `kiloclaw-precreated-provider-test-${Math.random()}@example.com`,
    });
    await ensureActiveInstance(user.id, { provider: 'northflank' });
    const caller = createCaller({ user });

    await caller.provision({});

    expect(kiloclawClientMock.__provisionMock).toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({ provider: 'northflank' }),
      expect.objectContaining({ instanceId: expect.any(String) })
    );
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
      inboundEmailAddress: null,
      inboundEmailEnabled: false,
    });
  });

  it('cycles the active inbound email address', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-cycle-test-${Math.random()}@example.com`,
    });
    const instanceId = crypto.randomUUID();
    const alias = `cycle-test-${instanceId.slice(0, 8)}`;
    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: user.id,
      sandbox_id: `ki_${instanceId.replace(/-/g, '')}`,
    });
    await db.insert(kiloclaw_inbound_email_reserved_aliases).values({ alias });
    await db.insert(kiloclaw_inbound_email_aliases).values({ alias, instance_id: instanceId });
    const caller = createCaller({ user });

    const result = await caller.cycleInboundEmailAddress();

    expect(result.inboundEmailAddress).toMatch(/@kiloclaw\.ai$/);
    expect(result.inboundEmailAddress).not.toBe(`${alias}@kiloclaw.ai`);
    const rows = await db
      .select()
      .from(kiloclaw_inbound_email_aliases)
      .where(eq(kiloclaw_inbound_email_aliases.instance_id, instanceId));
    expect(rows.find(row => row.alias === alias)?.retired_at).not.toBeNull();
    expect(rows.filter(row => row.retired_at === null)).toHaveLength(1);
  });
});

process.env.STRIPE_KILOCLAW_COMMIT_PRICE_ID ||= 'price_commit';
process.env.STRIPE_KILOCLAW_STANDARD_PRICE_ID ||= 'price_standard';
process.env.STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID ||= 'price_standard_intro';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createCallerFactory } from '@/lib/trpc/init';
import { kiloclawRouter } from '@/routers/kiloclaw-router';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kiloclaw_inbound_email_aliases,
  kiloclaw_inbound_email_reserved_aliases,
  kiloclaw_instances,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

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

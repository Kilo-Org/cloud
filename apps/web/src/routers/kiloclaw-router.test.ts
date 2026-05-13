process.env.STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID ||= 'price_legacy_standard_intro';
process.env.STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID ||= 'price_legacy_standard';
process.env.STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID ||= 'price_legacy_commit';
process.env.STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID ||= 'price_current_standard';
process.env.STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID ||= 'price_current_commit';
process.env.STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID ||= 'price_legacy_standard_intro';
process.env.STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID ||= 'price_legacy_standard';
process.env.STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID ||= 'price_legacy_commit';
process.env.STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID ||= 'price_current_standard';
process.env.STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID ||= 'price_current_commit';
process.env.KILOCLAW_API_URL ||= 'https://claw.test';
process.env.KILOCLAW_INTERNAL_API_SECRET ||= 'test-secret';

import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createCallerFactory } from '@/lib/trpc/init';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kiloclaw_inbound_email_aliases,
  kiloclaw_inbound_email_reserved_aliases,
  kiloclaw_instances,
  kiloclaw_attribution_touches,
  kiloclaw_referrals,
  kiloclaw_referral_conversions,
  kiloclaw_referral_reward_applications,
  kiloclaw_referral_reward_decisions,
  kiloclaw_referral_rewards,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';

(kiloclaw_subscriptions.kiloclaw_price_version as { defaultFn: () => string }).defaultFn = () =>
  LEGACY_KILOCLAW_PRICE_VERSION;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

type KiloClawClientMock = {
  KiloClawInternalClient: AnyMock;
  __getStatusMock: AnyMock;
  __destroyMock: AnyMock;
  __startMock: AnyMock;
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
  getStripePriceIdMetadata: jest.fn((priceId: string) => {
    if (priceId === 'price_commit') {
      return { plan: 'commit', priceVersion: '2026-03-19', isIntro: false };
    }
    if (priceId === 'price_standard') {
      return { plan: 'standard', priceVersion: '2026-03-19', isIntro: false };
    }
    if (priceId === 'price_standard_intro') {
      return { plan: 'standard', priceVersion: '2026-03-19', isIntro: true };
    }
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

jest.mock('@/lib/config.server', () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = jest.requireActual<typeof import('@/lib/config.server')>('@/lib/config.server');
  return {
    ...actual,
    KILOCLAW_API_URL: 'https://claw.test',
    KILOCLAW_INTERNAL_API_SECRET: 'test-secret',
  };
});

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const getStatusMock = jest.fn();
  const destroyMock = jest.fn();
  const startMock = jest.fn();
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      getStatus: getStatusMock,
      start: startMock,
      destroy: destroyMock,
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
    __destroyMock: destroyMock,
    __startMock: startMock,
  };
});

let createCaller: (ctx: { user: Awaited<ReturnType<typeof insertTestUser>> }) => {
  getStatus: () => Promise<unknown>;
  validateWeatherLocation: (input: { location: string }) => Promise<{
    location: string;
    currentWeatherText: string;
    status: 'validated' | 'service_unavailable';
  }>;
  cycleInboundEmailAddress: () => Promise<{ inboundEmailAddress: string }>;
  start: () => Promise<{
    ok: true;
    started: boolean;
    previousStatus: string | null;
    currentStatus: string | null;
    startedAt: number | null;
  }>;
  destroy: () => Promise<{ ok: true }>;
  getActivePersonalBillingStatus: () => Promise<{
    subscription: {
      referralRewards: {
        totalAppliedMonths: number;
        applications: Array<{
          role: string;
          appliedAt: string;
          monthsGranted: number;
          previousRenewalBoundary: string;
          newRenewalBoundary: string;
        }>;
      };
    } | null;
  }>;
  getSubscriptionDetail: (input: { instanceId: string }) => Promise<{
    referralRewards: {
      totalAppliedMonths: number;
      applications: Array<{
        role: string;
        appliedAt: string;
        monthsGranted: number;
        previousRenewalBoundary: string;
        newRenewalBoundary: string;
      }>;
    };
  }>;
  getReferralRewardSummary: () => Promise<{
    rewards: Array<{
      role: string;
      status: string;
      monthsGranted: number;
      earnedAt: string;
      appliedAt: string | null;
      application: {
        previousRenewalBoundary: string;
        newRenewalBoundary: string;
      } | null;
    }>;
    totals: {
      totalRewards: number;
      pendingRewards: number;
      totalAppliedMonths: number;
    };
    referredPeople: Array<{
      maskedEmail: string | null;
      state: string;
      rewardGranted: boolean;
    }>;
    pendingRewardAction: {
      showStartReactivateCta: boolean;
      pendingRewardCount: number;
    };
  }>;
};
const kiloclawClientMock = jest.requireMock<KiloClawClientMock>(
  '@/lib/kiloclaw/kiloclaw-internal-client'
);

beforeAll(async () => {
  const mod = await import('@/routers/kiloclaw-router');
  createCaller = createCallerFactory(mod.kiloclawRouter);
});

function wttrFormat3Response(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

const WTTR_SERVICE_UNAVAILABLE_MESSAGE =
  "wttr.in is down right now. We'll store your location as entered.";

function wttrLocationResponse(params: {
  areaName: string;
  region?: string;
  country?: string;
}): Response {
  return new Response(
    JSON.stringify({
      nearest_area: [
        {
          areaName: [{ value: params.areaName }],
          region: params.region ? [{ value: params.region }] : [],
          country: params.country ? [{ value: params.country }] : [],
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('kiloclawRouter validateWeatherLocation', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(async () => {
    await cleanupDbForTest();
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns the format=3 preview with a readable nearest-area location', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-weather-test-${Math.random()}@example.com`,
    });
    fetchSpy
      .mockResolvedValueOnce(wttrFormat3Response('Amsterdam: ☁️   +7°C'))
      .mockResolvedValueOnce(
        wttrLocationResponse({
          areaName: 'Binnenstad',
          region: 'North Holland',
          country: 'Netherlands',
        })
      );
    const caller = createCaller({ user });

    const result = await caller.validateWeatherLocation({ location: ' Amsterdam ' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'https://wttr.in/Amsterdam?format=3',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'curl/8.7.1' }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://wttr.in/Amsterdam?format=j1',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'curl/8.7.1' }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(result).toEqual({
      location: 'Amsterdam, The Netherlands',
      currentWeatherText: '☁️   +7°C',
      status: 'validated',
    });
  });

  it('resolves coordinate locations to a readable display location', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-weather-format-test-${Math.random()}@example.com`,
    });
    fetchSpy
      .mockResolvedValueOnce(wttrFormat3Response('53.2167,6.5667: ☀️   +9°C\n'))
      .mockResolvedValueOnce(
        wttrLocationResponse({
          areaName: 'Groningen',
          region: 'Groningen',
          country: 'Netherlands',
        })
      );
    const caller = createCaller({ user });

    const result = await caller.validateWeatherLocation({ location: '53.2167,6.5667' });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://wttr.in/53.2167%2C6.5667?format=j1',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'curl/8.7.1' }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(result).toEqual({
      location: 'Groningen, The Netherlands',
      currentWeatherText: '☀️   +9°C',
      status: 'validated',
    });
  });

  it('rejects unknown locations without returning raw input', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-weather-invalid-test-${Math.random()}@example.com`,
    });
    fetchSpy.mockResolvedValue(wttrFormat3Response('Unknown location; please try again.'));
    const caller = createCaller({ user });

    await expect(caller.validateWeatherLocation({ location: 'not-a-real-place' })).rejects.toThrow(
      'Weather location could not be found.'
    );
  });

  it('stores the typed location when wttr returns a malformed service response', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-weather-malformed-test-${Math.random()}@example.com`,
    });
    fetchSpy.mockResolvedValue(wttrFormat3Response('☁️   +7°C'));
    const caller = createCaller({ user });

    await expect(caller.validateWeatherLocation({ location: ' Amsterdam ' })).resolves.toEqual({
      location: 'Amsterdam',
      currentWeatherText: WTTR_SERVICE_UNAVAILABLE_MESSAGE,
      status: 'service_unavailable',
    });
  });

  it('stores the typed location when wttr validation times out', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-weather-timeout-test-${Math.random()}@example.com`,
    });
    const timeoutError = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    fetchSpy.mockRejectedValue(timeoutError);
    const caller = createCaller({ user });

    await expect(caller.validateWeatherLocation({ location: 'Amsterdam' })).resolves.toEqual({
      location: 'Amsterdam',
      currentWeatherText: WTTR_SERVICE_UNAVAILABLE_MESSAGE,
      status: 'service_unavailable',
    });
  });

  it('stores the typed location when wttr validation fails upstream', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-weather-upstream-test-${Math.random()}@example.com`,
    });
    fetchSpy.mockRejectedValue(new Error('network down'));
    const caller = createCaller({ user });

    await expect(caller.validateWeatherLocation({ location: 'Amsterdam' })).resolves.toEqual({
      location: 'Amsterdam',
      currentWeatherText: WTTR_SERVICE_UNAVAILABLE_MESSAGE,
      status: 'service_unavailable',
    });
  });

  it('stores the typed location when wttr returns a service error', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-weather-service-error-test-${Math.random()}@example.com`,
    });
    fetchSpy.mockResolvedValue(wttrFormat3Response('Bad Gateway', 502));
    const caller = createCaller({ user });

    await expect(caller.validateWeatherLocation({ location: 'Amsterdam' })).resolves.toEqual({
      location: 'Amsterdam',
      currentWeatherText: WTTR_SERVICE_UNAVAILABLE_MESSAGE,
      status: 'service_unavailable',
    });
  });

  it('rejects non-service wttr errors as unknown locations', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-weather-not-found-status-test-${Math.random()}@example.com`,
    });
    fetchSpy.mockResolvedValue(wttrFormat3Response('Not Found', 404));
    const caller = createCaller({ user });

    await expect(caller.validateWeatherLocation({ location: 'not-a-real-place' })).rejects.toThrow(
      'Weather location could not be found.'
    );
  });
});

describe('kiloclawRouter getStatus', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawClientMock.KiloClawInternalClient.mockClear();
    kiloclawClientMock.__getStatusMock.mockReset();
    kiloclawClientMock.__startMock.mockReset();
    kiloclawClientMock.__destroyMock.mockReset();
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
      instanceType: null,
      volumeSizeGb: null,
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
      workerUrl: 'https://claw.test',
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

describe('kiloclawRouter start', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawClientMock.KiloClawInternalClient.mockClear();
    kiloclawClientMock.__startMock.mockReset();
  });

  it('clears the inactivity marker after a successful personal trial start', async () => {
    kiloclawClientMock.__startMock.mockResolvedValue({
      ok: true,
      started: true,
      previousStatus: 'stopped',
      currentStatus: 'running',
      startedAt: 1_776_885_000_000,
    });

    const user = await insertTestUser({
      google_user_email: `kiloclaw-start-test-${Math.random()}@example.com`,
    });
    const instanceId = crypto.randomUUID();
    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: user.id,
      sandbox_id: `ki_${instanceId.replace(/-/g, '')}`,
      inactive_trial_stopped_at: '2026-04-20T12:00:00.000Z',
    });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instanceId,
      plan: 'trial',
      status: 'trialing',
      trial_ends_at: '2026-12-31T23:59:59.000Z',
    });

    const caller = createCaller({ user });
    const result = await caller.start();

    expect(result).toEqual({
      ok: true,
      started: true,
      previousStatus: 'stopped',
      currentStatus: 'running',
      startedAt: 1_776_885_000_000,
    });
    expect(kiloclawClientMock.__startMock).toHaveBeenCalledWith(user.id, instanceId, {
      reason: 'manual_user_request',
    });

    const [updatedInstance] = await db
      .select()
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, instanceId))
      .limit(1);
    expect(updatedInstance?.inactive_trial_stopped_at).toBeNull();
  });

  it('does not clear the inactivity marker when start is a no-op', async () => {
    kiloclawClientMock.__startMock.mockResolvedValue({
      ok: true,
      started: false,
      previousStatus: 'stopped',
      currentStatus: 'stopped',
      startedAt: null,
    });

    const user = await insertTestUser({
      google_user_email: `kiloclaw-start-noop-test-${Math.random()}@example.com`,
    });
    const instanceId = crypto.randomUUID();
    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: user.id,
      sandbox_id: `ki_${instanceId.replace(/-/g, '')}`,
      inactive_trial_stopped_at: '2026-04-20T12:00:00.000Z',
    });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instanceId,
      plan: 'trial',
      status: 'trialing',
      trial_ends_at: '2026-12-31T23:59:59.000Z',
    });

    const caller = createCaller({ user });
    const result = await caller.start();

    expect(result).toEqual({
      ok: true,
      started: false,
      previousStatus: 'stopped',
      currentStatus: 'stopped',
      startedAt: null,
    });

    const [updatedInstance] = await db
      .select()
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, instanceId))
      .limit(1);
    expect(new Date(String(updatedInstance?.inactive_trial_stopped_at)).toISOString()).toBe(
      '2026-04-20T12:00:00.000Z'
    );
  });
});

describe('kiloclawRouter getActivePersonalBillingStatus referral rewards', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  async function insertActivePersonalSubscription(userId: string) {
    const instanceId = crypto.randomUUID();
    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: userId,
      sandbox_id: `ki_${instanceId.replace(/-/g, '')}`,
    });
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: userId,
        instance_id: instanceId,
        payment_source: 'credits',
        plan: 'standard',
        status: 'active',
        current_period_start: '2026-04-01T00:00:00.000Z',
        current_period_end: '2026-06-01T00:00:00.000Z',
        credit_renewal_at: '2026-06-01T00:00:00.000Z',
      })
      .returning({ id: kiloclaw_subscriptions.id, instanceId: kiloclaw_subscriptions.instance_id });

    return { subscriptionId: subscription.id, instanceId: subscription.instanceId ?? instanceId };
  }

  async function insertAppliedReferralReward(params: {
    beneficiaryUserId: string;
    subscriptionId: string;
    role: 'referrer' | 'referee';
    sourcePaymentId: string;
  }) {
    const referee = await insertTestUser({
      google_user_email: `kiloclaw-reward-referee-${Math.random()}@example.com`,
    });
    const [conversion] = await db
      .insert(kiloclaw_referral_conversions)
      .values({
        referee_user_id: referee.id,
        referrer_user_id: params.role === 'referrer' ? params.beneficiaryUserId : null,
        winning_touch_type: 'referral',
        source_payment_id: params.sourcePaymentId,
        qualified: true,
        converted_at: '2026-04-10T00:00:00.000Z',
      })
      .returning({ id: kiloclaw_referral_conversions.id });
    const [decision] = await db
      .insert(kiloclaw_referral_reward_decisions)
      .values({
        conversion_id: conversion.id,
        beneficiary_user_id: params.beneficiaryUserId,
        beneficiary_role: params.role,
        outcome: 'granted',
        months_granted: 1,
      })
      .returning({ id: kiloclaw_referral_reward_decisions.id });
    const [reward] = await db
      .insert(kiloclaw_referral_rewards)
      .values({
        conversion_id: conversion.id,
        decision_id: decision.id,
        beneficiary_user_id: params.beneficiaryUserId,
        beneficiary_role: params.role,
        months_granted: 1,
        status: 'applied',
        applies_to_subscription_id: params.subscriptionId,
        earned_at: '2026-04-10T00:00:00.000Z',
        applied_at: '2026-04-10T00:05:00.000Z',
      })
      .returning({ id: kiloclaw_referral_rewards.id });
    await db.insert(kiloclaw_referral_reward_applications).values({
      reward_id: reward.id,
      beneficiary_user_id: params.beneficiaryUserId,
      subscription_id: params.subscriptionId,
      previous_renewal_boundary: '2026-05-01T00:00:00.000Z',
      new_renewal_boundary: '2026-06-01T00:00:00.000Z',
      applied_at: '2026-04-10T00:05:00.000Z',
    });
  }

  it('returns applied referral rewards for the active personal subscription', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-reward-status-${Math.random()}@example.com`,
    });
    const { subscriptionId, instanceId } = await insertActivePersonalSubscription(user.id);
    await insertAppliedReferralReward({
      beneficiaryUserId: user.id,
      subscriptionId,
      role: 'referrer',
      sourcePaymentId: `kiloclaw-subscription:${instanceId}:2026-04`,
    });

    const billing = await createCaller({ user }).getActivePersonalBillingStatus();

    expect(billing.subscription?.referralRewards).toEqual({
      totalAppliedMonths: 1,
      applications: [
        {
          role: 'referrer',
          appliedAt: '2026-04-10T00:05:00.000Z',
          monthsGranted: 1,
          previousRenewalBoundary: '2026-05-01T00:00:00.000Z',
          newRenewalBoundary: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('returns an empty referral reward summary when no applications belong to the subscription owner', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-empty-reward-status-${Math.random()}@example.com`,
    });
    const otherUser = await insertTestUser({
      google_user_email: `kiloclaw-other-reward-status-${Math.random()}@example.com`,
    });
    const { subscriptionId, instanceId } = await insertActivePersonalSubscription(user.id);
    await insertAppliedReferralReward({
      beneficiaryUserId: otherUser.id,
      subscriptionId,
      role: 'referrer',
      sourcePaymentId: `kiloclaw-subscription:${instanceId}:other-user`,
    });

    const billing = await createCaller({ user }).getActivePersonalBillingStatus();

    expect(billing.subscription?.referralRewards).toEqual({
      totalAppliedMonths: 0,
      applications: [],
    });
  });

  it('returns rewards for an explicitly viewed user-owned subscription', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-detail-reward-status-${Math.random()}@example.com`,
    });
    const { subscriptionId, instanceId } = await insertActivePersonalSubscription(user.id);
    await insertAppliedReferralReward({
      beneficiaryUserId: user.id,
      subscriptionId,
      role: 'referee',
      sourcePaymentId: `kiloclaw-subscription:${instanceId}:detail`,
    });

    const detail = await createCaller({ user }).getSubscriptionDetail({ instanceId });

    expect(detail.referralRewards).toEqual({
      totalAppliedMonths: 1,
      applications: [
        {
          role: 'referee',
          appliedAt: '2026-04-10T00:05:00.000Z',
          monthsGranted: 1,
          previousRenewalBoundary: '2026-05-01T00:00:00.000Z',
          newRenewalBoundary: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
  });
});

describe('kiloclawRouter getReferralRewardSummary', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  async function insertRewardSummaryReward(params: {
    userId: string;
    role: 'referrer' | 'referee';
    status: 'pending' | 'applied';
    sourcePaymentId: string;
  }) {
    const otherUser = await insertTestUser({
      google_user_email: `kiloclaw-summary-other-${Math.random()}@example.com`,
    });
    const [conversion] = await db
      .insert(kiloclaw_referral_conversions)
      .values({
        referee_user_id: params.role === 'referee' ? params.userId : otherUser.id,
        referrer_user_id: params.role === 'referrer' ? params.userId : otherUser.id,
        winning_touch_type: 'referral',
        source_payment_id: params.sourcePaymentId,
        qualified: true,
        converted_at: '2026-04-10T00:00:00.000Z',
      })
      .returning({ id: kiloclaw_referral_conversions.id });
    const [decision] = await db
      .insert(kiloclaw_referral_reward_decisions)
      .values({
        conversion_id: conversion.id,
        beneficiary_user_id: params.userId,
        beneficiary_role: params.role,
        outcome: 'granted',
        months_granted: 1,
      })
      .returning({ id: kiloclaw_referral_reward_decisions.id });
    const [reward] = await db
      .insert(kiloclaw_referral_rewards)
      .values({
        conversion_id: conversion.id,
        decision_id: decision.id,
        beneficiary_user_id: params.userId,
        beneficiary_role: params.role,
        months_granted: 1,
        status: params.status,
        earned_at: '2026-04-10T00:00:00.000Z',
        applied_at: params.status === 'applied' ? '2026-04-10T00:05:00.000Z' : null,
      })
      .returning({ id: kiloclaw_referral_rewards.id });

    if (params.status === 'applied') {
      await db.insert(kiloclaw_referral_reward_applications).values({
        reward_id: reward.id,
        beneficiary_user_id: params.userId,
        subscription_id: crypto.randomUUID(),
        previous_renewal_boundary: '2026-05-01T00:00:00.000Z',
        new_renewal_boundary: '2026-06-01T00:00:00.000Z',
        applied_at: '2026-04-10T00:05:00.000Z',
      });
    }
  }

  async function insertReferralRelationship(params: {
    referrerId: string;
    refereeEmail: string;
    sourcePaymentId?: string;
    qualified?: boolean;
    disqualificationReason?: string | null;
  }) {
    const referee = await insertTestUser({
      google_user_email: params.refereeEmail,
      normalized_email: params.refereeEmail,
    });
    const [touch] = await db
      .insert(kiloclaw_attribution_touches)
      .values({
        dedupe_key: `summary-relationship-touch-${params.refereeEmail}`,
        user_id: referee.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'private-cookie-value',
        tracking_value_length: 20,
        is_tracking_value_accepted: true,
        rs_code: 'RS-CUSTOMER',
        im_ref: 'private-impact-click',
        touched_at: '2026-04-01T00:00:00.000Z',
        expires_at: '2026-05-01T00:00:00.000Z',
      })
      .returning({ id: kiloclaw_attribution_touches.id });
    await db.insert(kiloclaw_referrals).values({
      referee_user_id: referee.id,
      referrer_user_id: params.referrerId,
      source_touch_id: touch.id,
      impact_referral_id: 'RS-CUSTOMER',
    });

    if (params.sourcePaymentId) {
      await db.insert(kiloclaw_referral_conversions).values({
        referee_user_id: referee.id,
        referrer_user_id: params.referrerId,
        source_touch_id: touch.id,
        winning_touch_type: 'referral',
        source_payment_id: params.sourcePaymentId,
        qualified: params.qualified ?? true,
        disqualification_reason: params.disqualificationReason ?? null,
        converted_at: '2026-04-10T00:00:00.000Z',
      });
    }
  }

  it('lists current-user rewards with status and application details', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-summary-${Math.random()}@example.com`,
    });
    const otherUser = await insertTestUser({
      google_user_email: `kiloclaw-summary-hidden-${Math.random()}@example.com`,
    });
    await insertRewardSummaryReward({
      userId: user.id,
      role: 'referrer',
      status: 'applied',
      sourcePaymentId: 'summary-applied',
    });
    await insertRewardSummaryReward({
      userId: user.id,
      role: 'referee',
      status: 'pending',
      sourcePaymentId: 'summary-pending',
    });
    await insertRewardSummaryReward({
      userId: otherUser.id,
      role: 'referrer',
      status: 'applied',
      sourcePaymentId: 'summary-other',
    });

    const summary = await createCaller({ user }).getReferralRewardSummary();

    expect(summary.totals).toEqual({
      totalRewards: 2,
      pendingRewards: 1,
      totalAppliedMonths: 1,
    });
    expect(summary.rewards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'referrer',
          status: 'applied',
          monthsGranted: 1,
          earnedAt: '2026-04-10T00:00:00.000Z',
          appliedAt: '2026-04-10T00:05:00.000Z',
          application: expect.objectContaining({
            previousRenewalBoundary: '2026-05-01T00:00:00.000Z',
            newRenewalBoundary: '2026-06-01T00:00:00.000Z',
          }),
        }),
        expect.objectContaining({
          role: 'referee',
          status: 'pending',
          monthsGranted: 1,
          application: null,
        }),
      ])
    );
  });

  it('returns customer-safe referred people and pending reward CTA state', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-summary-referrer-${Math.random()}@example.com`,
    });
    await insertRewardSummaryReward({
      userId: user.id,
      role: 'referrer',
      status: 'pending',
      sourcePaymentId: 'summary-pending-cta',
    });
    await insertReferralRelationship({
      referrerId: user.id,
      refereeEmail: 'qualified-referee@example.com',
      sourcePaymentId: 'summary-qualified-referee',
      qualified: true,
    });
    await insertReferralRelationship({
      referrerId: user.id,
      refereeEmail: 'signed-up-referee@example.com',
    });
    await insertReferralRelationship({
      referrerId: user.id,
      refereeEmail: 'disqualified-referee@example.com',
      sourcePaymentId: 'summary-disqualified-referee',
      qualified: false,
      disqualificationReason: 'referral_self_referral',
    });

    const summary = await createCaller({ user }).getReferralRewardSummary();

    expect(summary.pendingRewardAction).toEqual({
      showStartReactivateCta: true,
      pendingRewardCount: 1,
    });
    expect(summary.referredPeople).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          maskedEmail: 'q***@example.com',
          state: 'reward_granted',
          rewardGranted: true,
        }),
        expect.objectContaining({
          maskedEmail: 's***@example.com',
          state: 'waiting_for_paid_conversion',
          rewardGranted: false,
        }),
      ])
    );
    expect(summary.referredPeople).toHaveLength(2);
    expect(JSON.stringify(summary.referredPeople)).not.toContain('qualified-referee@example.com');
    expect(JSON.stringify(summary.referredPeople)).not.toContain('private-cookie-value');
    expect(JSON.stringify(summary.referredPeople)).not.toContain('private-impact-click');
    expect(JSON.stringify(summary.referredPeople)).not.toContain('referral_self_referral');
  });
});

describe('kiloclawRouter destroy', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawClientMock.KiloClawInternalClient.mockClear();
    kiloclawClientMock.__destroyMock.mockReset();
    kiloclawClientMock.__destroyMock.mockResolvedValue({ ok: true });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  });

  it('clears subscription destruction lifecycle and writes changelog', async () => {
    const user = await insertTestUser({
      google_user_email: `kiloclaw-destroy-test-${Math.random()}@example.com`,
    });
    const instanceId = crypto.randomUUID();
    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: user.id,
      sandbox_id: `ki_${instanceId.replace(/-/g, '')}`,
    });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instanceId,
      plan: 'standard',
      status: 'active',
      suspended_at: '2026-04-10T00:00:00.000Z',
      destruction_deadline: '2026-04-12T00:00:00.000Z',
    });

    const caller = createCaller({ user });
    const result = await caller.destroy();

    expect(result).toEqual({ ok: true });
    expect(kiloclawClientMock.__destroyMock).toHaveBeenCalledWith(user.id, instanceId, {
      reason: 'manual_user_request',
    });

    const [subscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, instanceId))
      .limit(1);

    expect(subscription.suspended_at).toBeNull();
    expect(subscription.destruction_deadline).toBeNull();

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, subscription.id));

    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(
      expect.objectContaining({
        actor_type: 'user',
        actor_id: user.id,
        action: 'status_changed',
        reason: 'instance_destroyed',
      })
    );
    expect(logs[0]?.before_state).toEqual(
      expect.objectContaining({
        suspended_at: expect.stringContaining('2026-04-10'),
        destruction_deadline: expect.stringContaining('2026-04-12'),
      })
    );
    expect(logs[0]?.after_state).toEqual(
      expect.objectContaining({
        suspended_at: null,
        destruction_deadline: null,
      })
    );
  });
});

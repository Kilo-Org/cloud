process.env.STRIPE_KILOCLAW_COMMIT_PRICE_ID ||= 'price_commit';
process.env.STRIPE_KILOCLAW_STANDARD_PRICE_ID ||= 'price_standard';
process.env.STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID ||= 'price_standard_intro';
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
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

type KiloClawClientMock = {
  KiloClawInternalClient: AnyMock;
  __getStatusMock: AnyMock;
  __destroyMock: AnyMock;
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
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      getStatus: getStatusMock,
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
  destroy: () => Promise<{ ok: true }>;
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

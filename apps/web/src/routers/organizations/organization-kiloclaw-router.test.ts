process.env.KILOCLAW_API_URL ||= 'https://claw.test';
process.env.KILOCLAW_INTERNAL_API_SECRET ||= 'test-secret';

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import {
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

type KiloClawClientMock = {
  __destroyMock: AnyMock;
};

jest.mock('@/lib/stripe-client', () => ({
  client: {
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
  },
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
  const destroyMock = jest.fn();
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
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
    __destroyMock: destroyMock,
  };
});

const kiloclawClientMock = jest.requireMock<KiloClawClientMock>(
  '@/lib/kiloclaw/kiloclaw-internal-client'
);
let createCallerForUser: (userId: string) => Promise<{
  organizations: {
    kiloclaw: {
      destroy: (input: { organizationId: string }) => Promise<{ ok: true }>;
    };
  };
}>;

beforeAll(async () => {
  const mod = await import('@/routers/test-utils');
  createCallerForUser = mod.createCallerForUser;
});

describe('organization kiloclaw destroy', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawClientMock.__destroyMock.mockReset();
    kiloclawClientMock.__destroyMock.mockResolvedValue({ ok: true });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  });

  it('clears organization subscription destruction lifecycle and writes changelog', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-destroy-${Math.random()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Destroy Test', user.id);
    const instanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: user.id,
      organization_id: organization.id,
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

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.destroy({
      organizationId: organization.id,
    });

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

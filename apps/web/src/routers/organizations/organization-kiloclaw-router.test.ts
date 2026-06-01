process.env.KILOCLAW_API_URL ||= 'https://claw.test';
process.env.INTERNAL_API_SECRET ||= 'test-secret';

import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import type { createCallerForUser as TestUtilsCallerFactory } from '@/routers/test-utils';
import { LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';
import {
  kiloclaw_image_catalog,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
  kiloclaw_version_pins,
  organization_seats_purchases,
  organizations,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

(kiloclaw_subscriptions.kiloclaw_price_version as { defaultFn: () => string }).defaultFn = () =>
  LEGACY_KILOCLAW_PRICE_VERSION;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

type KiloClawClientMock = {
  __destroyMock: AnyMock;
  __patchWebSearchConfigMock: AnyMock;
  __provisionMock: AnyMock;
  __restartGatewayProcessMock: AnyMock;
  __startMock: AnyMock;
  __stopMock: AnyMock;
  __writeOpenclawConfigFileMock: AnyMock;
};

type KiloClawUserClientMock = {
  __restartMachineMock: AnyMock;
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
    INTERNAL_API_SECRET: 'test-secret',
  };
});

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const destroyMock = jest.fn();
  const patchWebSearchConfigMock = jest.fn();
  const provisionMock = jest.fn();
  const restartGatewayProcessMock = jest.fn();
  const startMock = jest.fn();
  const stopMock = jest.fn();
  const writeOpenclawConfigFileMock = jest.fn();
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      destroy: destroyMock,
      patchWebSearchConfig: patchWebSearchConfigMock,
      provision: provisionMock,
      restartGatewayProcess: restartGatewayProcessMock,
      start: startMock,
      stop: stopMock,
      writeOpenclawConfigFile: writeOpenclawConfigFileMock,
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
    __patchWebSearchConfigMock: patchWebSearchConfigMock,
    __provisionMock: provisionMock,
    __restartGatewayProcessMock: restartGatewayProcessMock,
    __startMock: startMock,
    __stopMock: stopMock,
    __writeOpenclawConfigFileMock: writeOpenclawConfigFileMock,
  };
});

jest.mock('@/lib/kiloclaw/kiloclaw-user-client', () => {
  const restartMachineMock = jest.fn();
  return {
    KiloClawUserClient: jest.fn().mockImplementation(() => ({
      restartMachine: restartMachineMock,
    })),
    __restartMachineMock: restartMachineMock,
  };
});

const kiloclawClientMock = jest.requireMock<KiloClawClientMock>(
  '@/lib/kiloclaw/kiloclaw-internal-client'
);
const kiloclawUserClientMock = jest.requireMock<KiloClawUserClientMock>(
  '@/lib/kiloclaw/kiloclaw-user-client'
);
// Use the real test-utils caller type so we get the full router shape
// (destroy, patchWebSearchConfig, restartMachine, setMyPin, removeMyPin,
// etc.) without transcribing each procedure signature.
let createCallerForUser: typeof TestUtilsCallerFactory;

beforeAll(async () => {
  const mod = await import('@/routers/test-utils');
  createCallerForUser = mod.createCallerForUser;
});

async function createActiveOrgInstance(userId: string, organizationId: string): Promise<string> {
  const instanceId = crypto.randomUUID();
  const [row] = await db
    .insert(kiloclaw_instances)
    .values({
      id: instanceId,
      user_id: userId,
      organization_id: organizationId,
      sandbox_id: `ki_${instanceId.replace(/-/g, '')}`,
    })
    .returning({ id: kiloclaw_instances.id });

  if (!row) throw new Error('Failed to create organization KiloClaw instance');
  return row.id;
}

async function markOrganizationHardExpired(organizationId: string): Promise<void> {
  await db
    .update(organizations)
    .set({ free_trial_end_at: '2020-01-01T00:00:00.000Z' })
    .where(eq(organizations.id, organizationId));
}

async function addOrganizationSeatEntitlement(organizationId: string): Promise<void> {
  await db.insert(organization_seats_purchases).values({
    organization_id: organizationId,
    subscription_stripe_id: `sub_${crypto.randomUUID()}`,
    seat_count: 1,
    amount_usd: 72,
    starts_at: '2026-05-01T00:00:00.000Z',
    expires_at: '2026-06-01T00:00:00.000Z',
    subscription_status: 'past_due',
  });
}

describe('organizations.kiloclaw.listActiveInstances', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('excludes orphan and destroyed organization instances', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-list-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw List Test', user.id);
    await createActiveOrgInstance(user.id, organization.id);
    const activeInstanceId = await createActiveOrgInstance(user.id, organization.id);
    const suspendedInstanceId = await createActiveOrgInstance(user.id, organization.id);
    const destroyedInstanceId = await createActiveOrgInstance(user.id, organization.id);

    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: user.id,
        instance_id: activeInstanceId,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        cancel_at_period_end: false,
      },
      {
        user_id: user.id,
        instance_id: suspendedInstanceId,
        plan: 'standard',
        status: 'canceled',
        payment_source: 'credits',
        cancel_at_period_end: false,
        suspended_at: '2026-05-28T00:00:00.000Z',
      },
      {
        user_id: user.id,
        instance_id: destroyedInstanceId,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        cancel_at_period_end: false,
      },
    ]);
    await db
      .update(kiloclaw_instances)
      .set({ destroyed_at: '2026-05-28T00:00:00.000Z' })
      .where(eq(kiloclaw_instances.id, destroyedInstanceId));

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.listActiveInstances({
      organizationId: organization.id,
    });

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: activeInstanceId,
          userEmail: user.google_user_email,
          isSuspended: false,
        }),
        expect.objectContaining({
          id: suspendedInstanceId,
          userEmail: user.google_user_email,
          isSuspended: true,
        }),
      ])
    );
  });
});

describe('organizations.kiloclaw.getNavState', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('returns absent when the organization has no KiloClaw instance', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-nav-absent-${Math.random()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Nav Absent Test', user.id);
    const caller = await createCallerForUser(user.id);

    const result = await caller.organizations.kiloclaw.getNavState({
      organizationId: organization.id,
    });

    expect(result).toEqual({ hasActiveInstance: false });
  });

  it('returns active organization instance presence', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-nav-present-${Math.random()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Nav Present Test', user.id);
    await createActiveOrgInstance(user.id, organization.id);
    const caller = await createCallerForUser(user.id);

    const result = await caller.organizations.kiloclaw.getNavState({
      organizationId: organization.id,
    });

    expect(result).toEqual({ hasActiveInstance: true });
  });

  it('does not leak a personal instance into organization nav state', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-nav-personal-${Math.random()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Nav Personal Test', user.id);
    const personalInstanceId = crypto.randomUUID();
    await db.insert(kiloclaw_instances).values({
      id: personalInstanceId,
      user_id: user.id,
      sandbox_id: `ki_${personalInstanceId.replace(/-/g, '')}`,
    });
    const caller = await createCallerForUser(user.id);

    const result = await caller.organizations.kiloclaw.getNavState({
      organizationId: organization.id,
    });

    expect(result).toEqual({ hasActiveInstance: false });
  });

  it('ignores destroyed organization instances', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-nav-destroyed-${Math.random()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Nav Destroyed Test', user.id);
    const instanceId = await createActiveOrgInstance(user.id, organization.id);
    await db
      .update(kiloclaw_instances)
      .set({ destroyed_at: '2026-05-29T00:00:00.000Z' })
      .where(eq(kiloclaw_instances.id, instanceId));
    const caller = await createCallerForUser(user.id);

    const result = await caller.organizations.kiloclaw.getNavState({
      organizationId: organization.id,
    });

    expect(result).toEqual({ hasActiveInstance: false });
  });
});

describe('organization kiloclaw destroy', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawClientMock.__destroyMock.mockReset();
    kiloclawClientMock.__patchWebSearchConfigMock.mockReset();
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
    const instanceId = await createActiveOrgInstance(user.id, organization.id);

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

describe('organizations.kiloclaw.provision trial entitlement gate', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('rejects hard-expired unentitled organizations before provisioning', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-provision-expired-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Provision Expired Test', user.id);

    await markOrganizationHardExpired(organization.id);

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.provision({
        organizationId: organization.id,
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Organization KiloClaw entitlement has expired.',
    });
  });
});

describe('organizations.kiloclaw compute entitlement gates', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawClientMock.__destroyMock.mockReset();
    kiloclawClientMock.__provisionMock.mockReset();
    kiloclawClientMock.__restartGatewayProcessMock.mockReset();
    kiloclawClientMock.__startMock.mockReset();
    kiloclawClientMock.__stopMock.mockReset();
    kiloclawUserClientMock.__restartMachineMock.mockReset();
    kiloclawClientMock.__destroyMock.mockResolvedValue({ ok: true });
    kiloclawClientMock.__startMock.mockResolvedValue({ ok: true, started: true });
    kiloclawClientMock.__stopMock.mockResolvedValue({ ok: true, stopped: true });
  });

  it('returns entitlement failure before missing-instance lookup on hard-expired start', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-start-expired-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Start Expired Test', user.id);
    await markOrganizationHardExpired(organization.id);

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.start({ organizationId: organization.id })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Organization KiloClaw entitlement has expired.',
    });
    expect(kiloclawClientMock.__startMock).not.toHaveBeenCalled();
  });

  it('blocks hard-expired organization reprovision before upstream provision', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-update-expired-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Update Expired Test', user.id);
    await createActiveOrgInstance(user.id, organization.id);
    await markOrganizationHardExpired(organization.id);

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.updateConfig({ organizationId: organization.id })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Organization KiloClaw entitlement has expired.',
    });
    expect(kiloclawClientMock.__provisionMock).not.toHaveBeenCalled();
  });

  it('blocks hard-expired organization machine restart before upstream restart', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-restart-expired-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Restart Expired Test', user.id);
    await createActiveOrgInstance(user.id, organization.id);
    await markOrganizationHardExpired(organization.id);

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.restartMachine({ organizationId: organization.id })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Organization KiloClaw entitlement has expired.',
    });
    expect(kiloclawUserClientMock.__restartMachineMock).not.toHaveBeenCalled();
  });

  it('blocks hard-expired organization gateway-process restart before upstream restart', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-gateway-restart-expired-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization(
      'Org KiloClaw Gateway Restart Expired Test',
      user.id
    );
    await createActiveOrgInstance(user.id, organization.id);
    await markOrganizationHardExpired(organization.id);

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.restartOpenClaw({ organizationId: organization.id })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Organization KiloClaw entitlement has expired.',
    });
    expect(kiloclawClientMock.__restartGatewayProcessMock).not.toHaveBeenCalled();
  });

  it('keeps start available after hard expiry when seat entitlement remains', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-start-paid-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Start Paid Test', user.id);
    const instanceId = await createActiveOrgInstance(user.id, organization.id);
    await markOrganizationHardExpired(organization.id);
    await addOrganizationSeatEntitlement(organization.id);

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.start({ organizationId: organization.id })
    ).resolves.toEqual({ ok: true, started: true });
    expect(kiloclawClientMock.__startMock).toHaveBeenCalledWith(user.id, instanceId, {
      reason: 'manual_user_request',
    });
  });

  it('keeps manual stop available for hard-expired unentitled organizations', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-stop-expired-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Stop Expired Test', user.id);
    const instanceId = await createActiveOrgInstance(user.id, organization.id);
    await markOrganizationHardExpired(organization.id);

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.stop({ organizationId: organization.id })
    ).resolves.toEqual({ ok: true, stopped: true });
    expect(kiloclawClientMock.__stopMock).toHaveBeenCalledWith(user.id, instanceId, {
      reason: 'manual_user_request',
    });
  });

  it('keeps manual destroy available for hard-expired unentitled organizations', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-destroy-expired-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Destroy Expired Test', user.id);
    const instanceId = await createActiveOrgInstance(user.id, organization.id);
    await markOrganizationHardExpired(organization.id);

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.destroy({ organizationId: organization.id })
    ).resolves.toEqual({ ok: true });
    expect(kiloclawClientMock.__destroyMock).toHaveBeenCalledWith(user.id, instanceId, {
      reason: 'manual_user_request',
    });
  });
});

describe('organizations.kiloclaw.patchWebSearchConfig', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawClientMock.__destroyMock.mockReset();
    kiloclawClientMock.__patchWebSearchConfigMock.mockReset();
  });

  it('patches web search config for the active org instance', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-web-search-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Web Search Test', user.id);
    const instanceId = await createActiveOrgInstance(user.id, organization.id);
    kiloclawClientMock.__patchWebSearchConfigMock.mockResolvedValue({ exaMode: 'disabled' });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.patchWebSearchConfig({
        organizationId: organization.id,
        exaMode: 'disabled',
      })
    ).resolves.toEqual({ exaMode: 'disabled' });

    expect(kiloclawClientMock.__patchWebSearchConfigMock).toHaveBeenCalledTimes(1);
    expect(kiloclawClientMock.__patchWebSearchConfigMock).toHaveBeenCalledWith(
      user.id,
      { exaMode: 'disabled' },
      instanceId
    );

    const firstCall = kiloclawClientMock.__patchWebSearchConfigMock.mock.calls[0];
    if (!firstCall) throw new Error('Expected patchWebSearchConfig to be called');
    expect(firstCall[1]).not.toHaveProperty('organizationId');
  });

  it('rejects when the organization has no active instance', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-web-search-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw Web Search Test', user.id);
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.organizations.kiloclaw.patchWebSearchConfig({
        organizationId: organization.id,
        exaMode: 'disabled',
      })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'No active KiloClaw instance found for this organization',
    });

    expect(kiloclawClientMock.__patchWebSearchConfigMock).not.toHaveBeenCalled();
  });
});

describe('organizations.kiloclaw.writeFile validation mode', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawClientMock.__writeOpenclawConfigFileMock.mockReset();
  });

  it('normalizes openclaw.json and forwards validation-aware saves', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-write-file-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org KiloClaw File Write Test', user.id);
    const instanceId = await createActiveOrgInstance(user.id, organization.id);
    kiloclawClientMock.__writeOpenclawConfigFileMock.mockResolvedValue({
      outcome: 'openclaw-validation-warning',
      valid: false,
      reason: 'invalid',
      issues: [{ path: 'gateway.mode', message: 'Expected local' }],
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.writeFile({
        organizationId: organization.id,
        path: 'openclaw.json',
        content: '{"gateway":{"mode":"remote"}}',
        etag: 'etag-1',
        openclawValidation: 'warn-before-write',
      })
    ).resolves.toMatchObject({ outcome: 'openclaw-validation-warning', reason: 'invalid' });

    expect(kiloclawClientMock.__writeOpenclawConfigFileMock).toHaveBeenCalledWith(
      user.id,
      '{\n  "gateway": {\n    "mode": "remote"\n  }\n}',
      'etag-1',
      instanceId,
      'warn-before-write'
    );
  });
});

describe('organizations.kiloclaw.restartMachine pin consent gate', () => {
  // The pin row has an FK to kiloclaw_image_catalog.image_tag, so we
  // need real catalog rows for pin inserts. The restartMachine input
  // regex (^[a-zA-Z0-9][a-zA-Z0-9._-]*$) rejects slashes and colons, so
  // we use docker-tag-style identifiers here even though production
  // catalog rows use full registry URLs.
  const newerTag = 'org-pin-gate-newer';
  const olderTag = 'org-pin-gate-older';

  beforeEach(async () => {
    await cleanupDbForTest();
    kiloclawUserClientMock.__restartMachineMock.mockReset();
    kiloclawUserClientMock.__restartMachineMock.mockResolvedValue({
      success: true,
      message: 'restarting',
    });

    /* eslint-disable drizzle/enforce-delete-with-where */
    await db.delete(kiloclaw_image_catalog);
    /* eslint-enable drizzle/enforce-delete-with-where */
    await db.insert(kiloclaw_image_catalog).values([
      {
        openclaw_version: '2026.4.10',
        variant: 'default',
        image_tag: newerTag,
        image_digest: 'sha256:org-newer',
        status: 'available',
        published_at: new Date().toISOString(),
      },
      {
        openclaw_version: '2026.3.1',
        variant: 'default',
        image_tag: olderTag,
        image_digest: 'sha256:org-older',
        status: 'available',
        published_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      },
    ]);

    // pushPinToWorker calls into the platform API — stub fetch so the
    // gate's DO sync side-effect doesn't network in tests. Restored in
    // afterEach so we don't stack spies across tests in the same worker.
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          openclawVersion: null,
          imageTag: null,
          imageDigest: null,
          variant: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('plain restart (no imageTag) ignores pin state and never triggers the gate', async () => {
    const user = await insertTestUser({
      google_user_email: `org-restart-plain-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org Restart Plain Test', user.id);
    const instanceId = await createActiveOrgInstance(user.id, organization.id);

    await db.insert(kiloclaw_version_pins).values({
      instance_id: instanceId,
      image_tag: olderTag,
      pinned_by: user.id,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.restartMachine({
      organizationId: organization.id,
    });

    expect(result).toEqual({ success: true, message: 'restarting' });
    expect(kiloclawUserClientMock.__restartMachineMock).toHaveBeenCalledWith(
      undefined,
      expect.any(Object)
    );

    // Pin must remain untouched on plain restart.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, instanceId));
    expect(pins).toHaveLength(1);
  });

  it('restart with imageTag and no pin succeeds without acknowledgement', async () => {
    const user = await insertTestUser({
      google_user_email: `org-restart-no-pin-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org Restart No Pin Test', user.id);
    await createActiveOrgInstance(user.id, organization.id);

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.restartMachine({
      organizationId: organization.id,
      imageTag: newerTag,
    });

    expect(result).toEqual({ success: true, message: 'restarting' });
    expect(kiloclawUserClientMock.__restartMachineMock).toHaveBeenCalledWith(
      { imageTag: newerTag },
      expect.any(Object)
    );
  });

  it('restart with imageTag and pin without acknowledgement throws PIN_EXISTS', async () => {
    const user = await insertTestUser({
      google_user_email: `org-restart-pin-block-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org Restart Pin Block Test', user.id);
    const instanceId = await createActiveOrgInstance(user.id, organization.id);

    await db.insert(kiloclaw_version_pins).values({
      instance_id: instanceId,
      image_tag: olderTag,
      pinned_by: user.id,
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.restartMachine({
        organizationId: organization.id,
        imageTag: newerTag,
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'PIN_EXISTS' });

    expect(kiloclawUserClientMock.__restartMachineMock).not.toHaveBeenCalled();

    // Pin still in place after a blocked attempt.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, instanceId));
    expect(pins).toHaveLength(1);
    expect(pins[0]?.image_tag).toBe(olderTag);
  });

  it('restart with imageTag, pin, and acknowledgement clears pin and proceeds', async () => {
    const user = await insertTestUser({
      google_user_email: `org-restart-pin-clear-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org Restart Pin Clear Test', user.id);
    const instanceId = await createActiveOrgInstance(user.id, organization.id);

    await db.insert(kiloclaw_version_pins).values({
      instance_id: instanceId,
      image_tag: olderTag,
      pinned_by: user.id,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.restartMachine({
      organizationId: organization.id,
      imageTag: newerTag,
      acknowledgePinRemoval: true,
    });

    expect(result).toEqual({ success: true, message: 'restarting' });
    expect(kiloclawUserClientMock.__restartMachineMock).toHaveBeenCalledWith(
      { imageTag: newerTag },
      expect.any(Object)
    );

    // Pin row removed.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, instanceId));
    expect(pins).toHaveLength(0);
  });

  it('conditional delete does not remove a concurrently replaced pin row', async () => {
    // Direct DB-level test of the conditional-delete WHERE clause that
    // the gate uses. Captures the original pin's id and updated_at,
    // simulates a replacement (delete + re-insert with a new id), then
    // attempts the gate's conditional delete. The delete must not match
    // — that empty returning() is what the runtime gate maps to
    // PIN_EXISTS so the caller re-checks against the new pin instead of
    // overriding it. The router-level PIN_EXISTS surface is exercised
    // by the other tests in this suite; this one isolates the DB
    // invariant.
    const user = await insertTestUser({
      google_user_email: `org-restart-pin-race-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org Restart Pin Race Test', user.id);
    const instanceId = await createActiveOrgInstance(user.id, organization.id);

    const [originalPin] = await db
      .insert(kiloclaw_version_pins)
      .values({ instance_id: instanceId, image_tag: olderTag, pinned_by: user.id })
      .returning({
        id: kiloclaw_version_pins.id,
        updated_at: kiloclaw_version_pins.updated_at,
      });
    if (!originalPin) throw new Error('Expected original pin id');

    // Simulate someone replacing the pin between the gate's SELECT and
    // the conditional DELETE.
    await db.delete(kiloclaw_version_pins).where(eq(kiloclaw_version_pins.instance_id, instanceId));
    await db.insert(kiloclaw_version_pins).values({
      instance_id: instanceId,
      image_tag: newerTag,
      pinned_by: user.id,
    });

    const conditionalDelete = await db
      .delete(kiloclaw_version_pins)
      .where(
        and(
          eq(kiloclaw_version_pins.instance_id, instanceId),
          eq(kiloclaw_version_pins.id, originalPin.id),
          eq(kiloclaw_version_pins.updated_at, originalPin.updated_at)
        )
      )
      .returning({ id: kiloclaw_version_pins.id });

    expect(conditionalDelete).toHaveLength(0);

    // The replacement pin must still be in place — the conditional
    // delete did not remove someone else's row.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, instanceId));
    expect(pins).toHaveLength(1);
    expect(pins[0]?.image_tag).toBe(newerTag);
  });

  it('conditional delete does not remove a concurrently in-place updated pin row', async () => {
    // setMyPin uses onConflictDoUpdate which keeps the same row id but
    // bumps updated_at. Without checking updated_at, the gate would
    // silently delete a pin that was edited (image_tag, reason, or
    // pinned_by changed) since the SELECT — which is exactly the case
    // the reviewer flagged. This test pins updated_at as the optimistic
    // lock and asserts the gate's conditional delete refuses to fire.
    const user = await insertTestUser({
      google_user_email: `org-restart-pin-update-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org Restart Pin Update Test', user.id);
    const instanceId = await createActiveOrgInstance(user.id, organization.id);

    const [originalPin] = await db
      .insert(kiloclaw_version_pins)
      .values({
        instance_id: instanceId,
        image_tag: olderTag,
        pinned_by: user.id,
        reason: 'before',
      })
      .returning({
        id: kiloclaw_version_pins.id,
        updated_at: kiloclaw_version_pins.updated_at,
      });
    if (!originalPin) throw new Error('Expected original pin id');

    // Simulate setMyPin in-place edit: same row id, new image_tag and
    // updated_at. Force a distinct timestamp so the optimistic-lock
    // comparison can distinguish the two states reliably even on hosts
    // where consecutive defaultNow() calls land in the same microsecond.
    const bumpedUpdatedAt = new Date(Date.now() + 1000).toISOString();
    await db
      .update(kiloclaw_version_pins)
      .set({ image_tag: newerTag, reason: 'after', updated_at: bumpedUpdatedAt })
      .where(eq(kiloclaw_version_pins.id, originalPin.id));

    const conditionalDelete = await db
      .delete(kiloclaw_version_pins)
      .where(
        and(
          eq(kiloclaw_version_pins.instance_id, instanceId),
          eq(kiloclaw_version_pins.id, originalPin.id),
          eq(kiloclaw_version_pins.updated_at, originalPin.updated_at)
        )
      )
      .returning({ id: kiloclaw_version_pins.id });

    // Pin id is unchanged but updated_at moved — the conditional delete
    // must refuse to fire so the caller surfaces PIN_EXISTS at the
    // router layer.
    expect(conditionalDelete).toHaveLength(0);

    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, instanceId));
    expect(pins).toHaveLength(1);
    expect(pins[0]?.image_tag).toBe(newerTag);
    expect(pins[0]?.reason).toBe('after');
  });
});

describe('organizations.kiloclaw pin metadata mutations are unrestricted by who set the pin', () => {
  // Pins are advisory consent metadata — either an org member or an
  // admin can write or clear them at any time. The dialogue protection
  // lives on the version-change paths, not on these metadata mutations.
  const tagA = 'org-pin-meta-a';
  const tagB = 'org-pin-meta-b';

  beforeEach(async () => {
    await cleanupDbForTest();
    /* eslint-disable drizzle/enforce-delete-with-where */
    await db.delete(kiloclaw_image_catalog);
    /* eslint-enable drizzle/enforce-delete-with-where */
    await db.insert(kiloclaw_image_catalog).values([
      {
        openclaw_version: '2026.4.10',
        variant: 'default',
        image_tag: tagA,
        image_digest: 'sha256:org-meta-a',
        status: 'available',
        published_at: new Date().toISOString(),
      },
      {
        openclaw_version: '2026.4.11',
        variant: 'default',
        image_tag: tagB,
        image_digest: 'sha256:org-meta-b',
        status: 'available',
        published_at: new Date().toISOString(),
      },
    ]);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          openclawVersion: null,
          imageTag: null,
          imageDigest: null,
          variant: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('setMyPin overwrites an admin-set pin with the caller pin', async () => {
    const orgMember = await insertTestUser({
      google_user_email: `org-setmypin-member-${crypto.randomUUID()}@example.com`,
    });
    const adminUser = await insertTestUser({
      google_user_email: `org-setmypin-admin-${crypto.randomUUID()}@admin.example.com`,
      is_admin: true,
    });
    const organization = await createOrganization('Org SetMyPin Override Test', orgMember.id);
    const instanceId = await createActiveOrgInstance(orgMember.id, organization.id);

    await db.insert(kiloclaw_version_pins).values({
      instance_id: instanceId,
      image_tag: tagA,
      pinned_by: adminUser.id,
      reason: 'Admin pinned',
    });

    const caller = await createCallerForUser(orgMember.id);
    const result = await caller.organizations.kiloclaw.setMyPin({
      organizationId: organization.id,
      imageTag: tagB,
      reason: 'Member overrides',
    });

    expect(result.pinned_by).toBe(orgMember.id);
    expect(result.image_tag).toBe(tagB);
    expect(result.reason).toBe('Member overrides');

    // Single pin row, now owned by the org member.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, instanceId));
    expect(pins).toHaveLength(1);
    expect(pins[0]?.pinned_by).toBe(orgMember.id);
    expect(pins[0]?.image_tag).toBe(tagB);
  });

  it('removeMyPin clears an admin-set pin', async () => {
    const orgMember = await insertTestUser({
      google_user_email: `org-rmpin-member-${crypto.randomUUID()}@example.com`,
    });
    const adminUser = await insertTestUser({
      google_user_email: `org-rmpin-admin-${crypto.randomUUID()}@admin.example.com`,
      is_admin: true,
    });
    const organization = await createOrganization('Org RemoveMyPin Override Test', orgMember.id);
    const instanceId = await createActiveOrgInstance(orgMember.id, organization.id);

    await db.insert(kiloclaw_version_pins).values({
      instance_id: instanceId,
      image_tag: tagA,
      pinned_by: adminUser.id,
    });

    const caller = await createCallerForUser(orgMember.id);
    const result = await caller.organizations.kiloclaw.removeMyPin({
      organizationId: organization.id,
    });

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(true);

    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, instanceId));
    expect(pins).toHaveLength(0);
  });

  it('removeMyPin is idempotent when no pin exists', async () => {
    const orgMember = await insertTestUser({
      google_user_email: `org-rmpin-empty-${crypto.randomUUID()}@example.com`,
    });
    const organization = await createOrganization('Org RemoveMyPin Empty Test', orgMember.id);
    await createActiveOrgInstance(orgMember.id, organization.id);

    const caller = await createCallerForUser(orgMember.id);
    const result = await caller.organizations.kiloclaw.removeMyPin({
      organizationId: organization.id,
    });

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(false);
  });
});

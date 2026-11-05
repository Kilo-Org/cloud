import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  ensureMemberOrganizationAccess,
  ensureOrganizationAccess,
  ensureOrganizationAccessAndFetchOrg,
  ensureOrganizationsAccess,
  getOrganizationsAccessRoles,
  requireLiveOrganizationForPlatformAdmin,
  resolveOrganizationAccess,
} from './utils';
import {
  setAdminAccessSinkForTest,
  type AdminAccessEvent,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  passkey_credentials,
  session_step_up_proofs,
  support_access_grant_events,
  support_access_grants,
  type User,
} from '@kilocode/db/schema';
import { hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';
import { eq } from 'drizzle-orm';

/**
 * `is_admin` on these helpers is the escape hatch that lets a Kilo employee read
 * any customer organization from a plain `baseProcedure`. It bypasses both
 * `admin_access` guard choke points, so the audit trail depends entirely on the
 * `kilo_admin_elevation` emit inside each branch.
 */
describe('organization access kilo_admin_elevation telemetry', () => {
  let events: AdminAccessEvent[];

  beforeEach(() => {
    events = [];
    setAdminAccessSinkForTest(event => events.push(event));
  });

  afterEach(async () => {
    setAdminAccessSinkForTest(null);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  function ctxFor(user: User): TRPCContext {
    return {
      user,
      authViaToken: true,
      tokenSource: 'cloud-agent',
      ip: '203.0.113.7',
      trpcPath: 'organizations.getSettings',
      trpcType: 'query',
    };
  }

  async function orgOwnedByAnotherUser() {
    const owner = await insertTestUser({ is_admin: false });
    return createTestOrganization(`elevation-test-${crypto.randomUUID()}`, owner.id, 0);
  }

  async function softDeleteOrganization(organizationId: string) {
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organizationId));
  }

  describe('admin access to organizations marked deleted', () => {
    test('an admin elevation never applies to a deleted organization', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const organization = await orgOwnedByAnotherUser();
      await softDeleteOrganization(organization.id);

      await expect(ensureOrganizationAccess(ctxFor(admin), organization.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        ensureOrganizationAccessAndFetchOrg(ctxFor(admin), organization.id)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // The fetch helper attributes the attempt before resolving it; the
      // access helper records nothing because no elevation was granted.
      const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
      expect(elevationEvents).toHaveLength(1);
      expect(elevationEvents[0]).toMatchObject({ reason: 'organization_fetch' });
    });

    test('a batched admin resolution elevates only live organizations', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const active = await orgOwnedByAnotherUser();
      const alsoActive = await orgOwnedByAnotherUser();
      const deleted = await orgOwnedByAnotherUser();
      await softDeleteOrganization(deleted.id);

      const roles = await getOrganizationsAccessRoles(ctxFor(admin), [
        active.id,
        alsoActive.id,
        deleted.id,
      ]);

      expect(roles.get(active.id)).toBe('owner');
      expect(roles.get(alsoActive.id)).toBe('owner');
      expect(roles.has(deleted.id)).toBe(false);
      const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
      expect(elevationEvents).toHaveLength(1);
      expect(elevationEvents[0]).toMatchObject({
        reason: 'organization_access_batch',
        target: 'organizations:2',
      });
    });

    test('a batched admin resolution records no elevation when every organization is deleted', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const deleted = await orgOwnedByAnotherUser();
      await softDeleteOrganization(deleted.id);

      const roles = await getOrganizationsAccessRoles(ctxFor(admin), [deleted.id]);

      expect(roles.size).toBe(0);
      expect(events).toHaveLength(0);
    });

    test('the batched guard rejects a request that names a deleted organization', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const active = await orgOwnedByAnotherUser();
      const deleted = await orgOwnedByAnotherUser();
      await softDeleteOrganization(deleted.id);

      await expect(
        ensureOrganizationsAccess(ctxFor(admin), [active.id, deleted.id])
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(ensureOrganizationsAccess(ctxFor(admin), [active.id])).resolves.toBeUndefined();
    });
  });

  test('ensureOrganizationAccess records the org an admin reached without membership', async () => {
    const admin = await insertTestUser({ is_admin: true, is_super_admin: true });
    const organization = await orgOwnedByAnotherUser();

    await expect(ensureOrganizationAccess(ctxFor(admin), organization.id)).resolves.toBe('owner');

    const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
    expect(elevationEvents).toHaveLength(1);
    expect(elevationEvents[0]).toMatchObject({
      event: 'admin_access',
      surface: 'trpc',
      kind: 'kilo_admin_elevation',
      kiloUserId: admin.id,
      adminTier: 'super_admin',
      authVia: 'token',
      tokenSource: 'cloud-agent',
      route: 'organizations.getSettings',
      method: 'query',
      ip: '203.0.113.7',
      reason: 'organization_access',
      target: `organization:${organization.id}`,
    });
  });

  test('ensureOrganizationAccess does not label a REST caller as a tRPC request', async () => {
    // Route handlers such as `/api/cloud-agent/sessions/stream-ticket` and
    // `/api/auto-routing/custom-routers` call this helper with a hand-rolled
    // `{ user }`. Labelling those `surface:"trpc"`/`authVia:"session"` would
    // hide a token-authenticated admin read behind a web-console-looking event.
    const admin = await insertTestUser({ is_admin: true });
    const organization = await orgOwnedByAnotherUser();

    await expect(ensureOrganizationAccess({ user: admin }, organization.id)).resolves.toBe('owner');

    const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
    expect(elevationEvents).toHaveLength(1);
    expect(elevationEvents[0]).toMatchObject({
      surface: 'rest',
      kind: 'kilo_admin_elevation',
      kiloUserId: admin.id,
      route: null,
      method: null,
      reason: 'organization_access',
      target: `organization:${organization.id}`,
    });
  });

  function failMembershipQueries() {
    const originalSelect = db.select.bind(db);
    return jest.spyOn(db, 'select').mockImplementation((...args) => {
      const builder = originalSelect(...args);
      return new Proxy(builder, {
        get(target, property, receiver) {
          if (property === 'from') {
            return (table: Parameters<typeof target.from>[0]) => {
              if (table === organization_memberships) {
                throw new Error('membership query failed');
              }
              return target.from(table);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
  }

  test('a membership observation failure never fails the admin request', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const organization = await orgOwnedByAnotherUser();

    const selectSpy = failMembershipQueries();
    try {
      await expect(ensureOrganizationAccess(ctxFor(admin), organization.id)).resolves.toBe('owner');
    } finally {
      selectSpy.mockRestore();
    }

    expect(events.find(event => event.kind === 'kilo_admin_elevation')).toMatchObject({
      kind: 'kilo_admin_elevation',
      membershipRole: null,
      wouldPassWithoutAdmin: null,
    });
  });

  test('a membership observation failure never fails the batch admin request', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const organization = await orgOwnedByAnotherUser();

    const selectSpy = failMembershipQueries();
    let roles: Map<string, string>;
    try {
      roles = await getOrganizationsAccessRoles(ctxFor(admin), [organization.id]);
    } finally {
      selectSpy.mockRestore();
    }

    expect(roles.get(organization.id)).toBe('owner');
    expect(events.find(event => event.kind === 'kilo_admin_elevation')).toMatchObject({
      kind: 'kilo_admin_elevation',
      membershipRole: null,
      wouldPassWithoutAdmin: null,
    });
  });

  test('ensureOrganizationAccess stays silent for a member resolving their own org', async () => {
    const member = await insertTestUser({ is_admin: false });
    const organization = await createTestOrganization(
      `elevation-test-${crypto.randomUUID()}`,
      member.id,
      0
    );

    await expect(ensureOrganizationAccess(ctxFor(member), organization.id)).resolves.toBe('owner');

    expect(events).toHaveLength(0);
  });

  test('getOrganizationsAccessRoles records one event carrying the batch breadth', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const first = await orgOwnedByAnotherUser();
    const second = await orgOwnedByAnotherUser();

    const roles = await getOrganizationsAccessRoles(ctxFor(admin), [
      first.id,
      second.id,
      second.id,
    ]);

    expect(roles.get(first.id)).toBe('owner');
    expect(roles.get(second.id)).toBe('owner');
    const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
    expect(elevationEvents).toHaveLength(1);
    expect(elevationEvents[0]).toMatchObject({
      kind: 'kilo_admin_elevation',
      reason: 'organization_access_batch',
      target: 'organizations:2',
    });
  });

  test('batch observation honors required roles instead of any membership', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const organization = await orgOwnedByAnotherUser();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: admin.id,
      role: 'member',
    });

    await getOrganizationsAccessRoles(ctxFor(admin), [organization.id], ['owner']);

    expect(events.find(event => event.kind === 'kilo_admin_elevation')).toMatchObject({
      kind: 'kilo_admin_elevation',
      reason: 'organization_access_batch',
      membershipRole: null,
      wouldPassWithoutAdmin: false,
    });
  });

  test('ensureOrganizationAccessAndFetchOrg records the org an admin fetched', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const organization = await orgOwnedByAnotherUser();

    const fetched = await ensureOrganizationAccessAndFetchOrg(ctxFor(admin), organization.id);

    expect(fetched.id).toBe(organization.id);
    const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
    expect(elevationEvents).toHaveLength(1);
    expect(elevationEvents[0]).toMatchObject({
      kind: 'kilo_admin_elevation',
      reason: 'organization_fetch',
      target: `organization:${organization.id}`,
    });
  });

  test('ensureOrganizationAccessAndFetchOrg records an admin probing a missing org', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const missingId = crypto.randomUUID();

    await expect(ensureOrganizationAccessAndFetchOrg(ctxFor(admin), missingId)).rejects.toThrow(
      /Organization not found/
    );

    const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
    expect(elevationEvents).toHaveLength(1);
    expect(elevationEvents[0]).toMatchObject({
      reason: 'organization_fetch',
      target: `organization:${missingId}`,
    });
  });

  test('denies direct membership in a soft-deleted organization', async () => {
    const member = await insertTestUser();
    const organization = await createTestOrganization(
      `deleted-direct-${crypto.randomUUID()}`,
      member.id,
      0
    );
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organization.id));

    await expect(ensureOrganizationAccess(ctxFor(member), organization.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const roles = await getOrganizationsAccessRoles(ctxFor(member), [organization.id]);
    expect(roles.has(organization.id)).toBe(false);
    await expect(
      ensureOrganizationAccessAndFetchOrg(ctxFor(member), organization.id)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('keeps parent-inherited access while the target and parent are live', async () => {
    const parentOwner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createTestOrganization(
      `live-parent-${crypto.randomUUID()}`,
      parentOwner.id,
      0
    );
    const child = await createTestOrganization(
      `live-child-${crypto.randomUUID()}`,
      childOwner.id,
      0
    );
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));

    await expect(ensureOrganizationAccess(ctxFor(parentOwner), child.id)).resolves.toBe('owner');
    await expect(getOrganizationsAccessRoles(ctxFor(parentOwner), [child.id])).resolves.toEqual(
      new Map([[child.id, 'owner']])
    );
    const fetched = await ensureOrganizationAccessAndFetchOrg(ctxFor(parentOwner), child.id);
    expect(fetched.id).toBe(child.id);
  });

  test('denies inherited access when the target organization is soft-deleted', async () => {
    const parentOwner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createTestOrganization(`parent-${crypto.randomUUID()}`, parentOwner.id, 0);
    const child = await createTestOrganization(
      `deleted-child-${crypto.randomUUID()}`,
      childOwner.id,
      0
    );
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id, deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, child.id));

    await expect(ensureOrganizationAccess(ctxFor(parentOwner), child.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('denies inherited access when the parent organization is soft-deleted', async () => {
    const parentOwner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createTestOrganization(
      `deleted-parent-${crypto.randomUUID()}`,
      parentOwner.id,
      0
    );
    const child = await createTestOrganization(`child-${crypto.randomUUID()}`, childOwner.id, 0);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, parent.id));

    await expect(ensureOrganizationAccess(ctxFor(parentOwner), child.id)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

function setSupportEnabled(enabled: boolean) {
  if (enabled) process.env.SUPPORT_ACCESS_ENABLED = 'true';
  else delete process.env.SUPPORT_ACCESS_ENABLED;
}

describe('binary support organization access', () => {
  let events: AdminAccessEvent[];
  const originalAdminStepUp = process.env.ADMIN_STEP_UP_ENABLED;

  beforeEach(() => {
    events = [];
    setAdminAccessSinkForTest(event => events.push(event));
    setSupportEnabled(false);
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
  });

  afterEach(async () => {
    setSupportEnabled(false);
    if (originalAdminStepUp === undefined) delete process.env.ADMIN_STEP_UP_ENABLED;
    else process.env.ADMIN_STEP_UP_ENABLED = originalAdminStepUp;
    setAdminAccessSinkForTest(null);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(support_access_grant_events);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(support_access_grants);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  async function orgAndAdmin() {
    const owner = await insertTestUser({ is_admin: false });
    const organization = await createTestOrganization(
      `support-binary-${crypto.randomUUID()}`,
      owner.id,
      0
    );
    const admin = await insertTestUser({ is_admin: true });
    return { organization, admin };
  }

  async function insertGrant(params: {
    actorKiloUserId: string;
    organizationId: string;
    actionClass: 'support_read' | 'support_write';
    approverKiloUserId?: string;
    status?: 'active' | 'expired' | 'revoked';
  }) {
    const now = new Date();
    const expired = params.status === 'expired';
    const [grant] = await db
      .insert(support_access_grants)
      .values({
        actor_kilo_user_id: params.actorKiloUserId,
        organization_id: params.organizationId,
        action_class: params.actionClass,
        status: params.status ?? 'active',
        reason: 'investigating a customer report',
        requested_duration_seconds: 1800,
        issued_at: new Date(now.getTime() - (expired ? 60 * 60 * 1000 : 0)).toISOString(),
        expires_at: new Date(
          now.getTime() + (expired ? -30 * 60 * 1000 : 10 * 60 * 1000)
        ).toISOString(),
        approved_by_kilo_user_id: params.approverKiloUserId ?? null,
      })
      .returning();
    return grant;
  }

  function readCtx(user: User): TRPCContext {
    return {
      user,
      trpcPath: 'organizations.usageStats',
      trpcType: 'query',
    };
  }

  const writeSessionId = 'support-write-use-session';

  async function enroll(userId: string) {
    const [credential] = await db
      .insert(passkey_credentials)
      .values({
        kilo_user_id: userId,
        credential_id: `support-write-${crypto.randomUUID()}`,
        public_key: 'unused-public-key',
      })
      .returning();
    return credential!.id;
  }

  async function insertStepUpProof(
    userId: string,
    credentialId: string,
    verifiedAt = new Date(),
    expiresAt = new Date(Date.now() + 15 * 60_000)
  ) {
    await db.insert(session_step_up_proofs).values({
      kilo_user_id: userId,
      session_id_hash: hashWebSessionId(writeSessionId),
      method: 'webauthn_uv',
      passkey_credential_id: credentialId,
      purpose: 'session',
      verified_at: verifiedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
  }

  async function writeCtxWithStepUpForPath(user: User, trpcPath: string): Promise<TRPCContext> {
    const credentialId = await enroll(user.id);
    await insertStepUpProof(user.id, credentialId);
    return {
      user,
      credential: 'session',
      webSessionId: writeSessionId,
      trpcPath,
      trpcType: 'mutation',
    };
  }

  async function writeCtxWithStepUp(user: User): Promise<TRPCContext> {
    return writeCtxWithStepUpForPath(user, 'organizations.settings.updateDefaultModel');
  }

  function failGrantLookupQueries() {
    const originalSelect = db.select.bind(db);
    return jest.spyOn(db, 'select').mockImplementation((...args) => {
      const builder = originalSelect(...args);
      return new Proxy(builder, {
        get(target, property, receiver) {
          if (property === 'from') {
            return (table: Parameters<typeof target.from>[0]) => {
              if (table === support_access_grants) {
                throw new Error('grant lookup failed');
              }
              return target.from(table);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
  }

  test('OFF keeps the legacy owner shortcut without querying grants', async () => {
    const { organization, admin } = await orgAndAdmin();
    const selectSpy = failGrantLookupQueries();
    try {
      await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).resolves.toBe(
        'owner'
      );
    } finally {
      selectSpy.mockRestore();
    }
    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({ reason: 'organization_access' });
    expect(event).toMatchObject({ supportDecision: null });
  });

  test('OFF records the elevation before rethrowing an organization lookup failure', async () => {
    const { organization, admin } = await orgAndAdmin();
    const originalSelect = db.select.bind(db);
    const selectSpy = jest.spyOn(db, 'select').mockImplementation((...args) => {
      const builder = originalSelect(...args);
      return new Proxy(builder, {
        get(target, property, receiver) {
          if (property === 'from') {
            return (table: Parameters<typeof target.from>[0]) => {
              if (table === organizations) {
                const failing = {
                  where: () => failing,
                  limit: () => Promise.reject(new Error('organization lookup failed')),
                };
                return failing as never;
              }
              return target.from(table);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    try {
      await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).rejects.toThrow(
        'organization lookup failed'
      );
    } finally {
      selectSpy.mockRestore();
    }
    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({ reason: 'organization_access' });
  });

  test('ON denies an admin without a grant with a specific code', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();

    await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ supportAccessReason: 'support_grant_required' }),
    });
  });

  test('ON admits an allowlisted read with a read grant', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });

    await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).resolves.toBe('member');
    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({ supportDecision: 'support_grant' });
  });

  test('ON admits an allowlisted write only with an approved write grant', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    const approver = await insertTestUser({ is_admin: true });
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_write',
      approverKiloUserId: approver.id,
    });
    const writeCtx = await writeCtxWithStepUp(admin);

    await expect(ensureOrganizationAccess(writeCtx, organization.id)).resolves.toBe('admin');
  });

  test('ON write use rejects a bearer credential', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    const approver = await insertTestUser({ is_admin: true });
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_write',
      approverKiloUserId: approver.id,
    });

    await expect(
      ensureOrganizationAccess(
        {
          user: admin,
          credential: 'human_bearer',
          trpcPath: 'organizations.settings.updateDefaultModel',
          trpcType: 'mutation',
        },
        organization.id
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'BEARER_NOT_ALLOWED' }),
    });
  });

  test('ON write use requires a fresh proof', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    const approver = await insertTestUser({ is_admin: true });
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_write',
      approverKiloUserId: approver.id,
    });
    await enroll(admin.id);

    await expect(
      ensureOrganizationAccess(
        {
          user: admin,
          credential: 'session',
          webSessionId: writeSessionId,
          trpcPath: 'organizations.settings.updateDefaultModel',
          trpcType: 'mutation',
        },
        organization.id
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'MFA_REQUIRED' }),
    });
  });

  test('ON write use rejects an expired proof as MFA_EXPIRED', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    const approver = await insertTestUser({ is_admin: true });
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_write',
      approverKiloUserId: approver.id,
    });
    const credentialId = await enroll(admin.id);
    await insertStepUpProof(
      admin.id,
      credentialId,
      new Date(Date.now() - 2 * 60 * 60_000),
      new Date(Date.now() - 60_000)
    );

    await expect(
      ensureOrganizationAccess(
        {
          user: admin,
          credential: 'session',
          webSessionId: writeSessionId,
          trpcPath: 'organizations.settings.updateDefaultModel',
          trpcType: 'mutation',
        },
        organization.id
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'MFA_EXPIRED' }),
    });
  });

  test('ON write use fails closed when step-up evaluation throws', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    const approver = await insertTestUser({ is_admin: true });
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_write',
      approverKiloUserId: approver.id,
    });
    const originalSelect = db.select.bind(db);
    const selectSpy = jest.spyOn(db, 'select').mockImplementation((...args) => {
      const builder = originalSelect(...args);
      return new Proxy(builder, {
        get(target, property, receiver) {
          if (property === 'from') {
            return (table: Parameters<typeof target.from>[0]) => {
              if (table === passkey_credentials) {
                throw new Error('step-up store unavailable');
              }
              return target.from(table);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    try {
      await expect(
        ensureOrganizationAccess(
          {
            user: admin,
            credential: 'session',
            webSessionId: writeSessionId,
            trpcPath: 'organizations.settings.updateDefaultModel',
            trpcType: 'mutation',
          },
          organization.id
        )
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: expect.objectContaining({ code: 'STEP_UP_UNAVAILABLE' }),
      });
    } finally {
      selectSpy.mockRestore();
    }
  });

  test('ON read grants still work with a bearer credential', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });

    await expect(
      ensureOrganizationAccess(
        {
          user: admin,
          credential: 'human_bearer',
          trpcPath: 'organizations.usageStats',
          trpcType: 'query',
        },
        organization.id
      )
    ).resolves.toBe('member');
  });

  test('ON denies GitHub install cancellation through support', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    const approver = await insertTestUser({ is_admin: true });
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_write',
      approverKiloUserId: approver.id,
    });

    await expect(
      ensureOrganizationAccess(
        await writeCtxWithStepUpForPath(admin, 'githubApps.cancelPendingInstallation'),
        organization.id
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ supportAccessReason: 'support_access_not_allowlisted' }),
    });
  });

  test('ON denies a read grant on a write procedure', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });

    await expect(
      ensureOrganizationAccess(
        {
          user: admin,
          trpcPath: 'organizations.settings.updateDefaultModel',
          trpcType: 'mutation',
        },
        organization.id
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('ON picks the write grant even when a longer read grant exists', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    const approver = await insertTestUser({ is_admin: true });
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_write',
      approverKiloUserId: approver.id,
    });

    await expect(
      ensureOrganizationAccess(await writeCtxWithStepUp(admin), organization.id)
    ).resolves.toBe('admin');
  });

  test('ON denies a never-list surface with any grant', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_write',
      approverKiloUserId: (await insertTestUser({ is_admin: true })).id,
    });

    await expect(
      resolveOrganizationAccess({ user: admin, trpcType: 'POST' }, organization.id, {
        surface: 'rest',
        supportKey: '/api/organizations/[id]/user-tokens',
        requiredActionClass: 'support_write',
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ supportAccessReason: 'support_access_not_allowlisted' }),
    });
  });

  test('ON denies expired and revoked grants with specific codes', async () => {
    setSupportEnabled(true);
    const expired = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: expired.admin.id,
      organizationId: expired.organization.id,
      actionClass: 'support_read',
      status: 'expired',
    });
    await expect(
      ensureOrganizationAccess(readCtx(expired.admin), expired.organization.id)
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ supportAccessReason: 'support_grant_expired' }),
    });

    const revoked = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: revoked.admin.id,
      organizationId: revoked.organization.id,
      actionClass: 'support_read',
      status: 'revoked',
    });
    await expect(
      ensureOrganizationAccess(readCtx(revoked.admin), revoked.organization.id)
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ supportAccessReason: 'support_grant_revoked' }),
    });
  });

  test('ON fails closed when the grant lookup fails', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    const selectSpy = failGrantLookupQueries();
    try {
      await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).rejects.toMatchObject(
        {
          code: 'FORBIDDEN',
          cause: expect.objectContaining({
            supportAccessReason: 'support_grant_lookup_failed',
          }),
        }
      );
    } finally {
      selectSpy.mockRestore();
    }
  });

  test('a real member keeps access in both states', async () => {
    for (const enabled of [false, true]) {
      setSupportEnabled(enabled);
      const owner = await insertTestUser({ is_admin: false });
      const organization = await createTestOrganization(
        `support-member-${crypto.randomUUID()}`,
        owner.id,
        0
      );
      await expect(ensureOrganizationAccess({ user: owner }, organization.id)).resolves.toBe(
        'owner'
      );
      // eslint-disable-next-line drizzle/enforce-delete-with-where
      await db.delete(organization_memberships);
      // eslint-disable-next-line drizzle/enforce-delete-with-where
      await db.delete(organizations);
    }
  });

  test('an admin with a real membership uses the real role when ON', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: admin.id,
      role: 'billing_manager',
      invited_by: 'test',
    });

    await expect(
      ensureOrganizationAccess(readCtx(admin), organization.id, ['owner'])
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });
    await expect(
      ensureOrganizationAccess(readCtx(admin), organization.id, ['billing_manager'])
    ).resolves.toBe('billing_manager');
  });

  test('a superadmin can use an emergency write grant', async () => {
    setSupportEnabled(true);
    const { organization } = await orgAndAdmin();
    const superadmin = await insertTestUser({ is_admin: true, is_super_admin: true });
    const now = new Date();
    await db.insert(support_access_grants).values({
      actor_kilo_user_id: superadmin.id,
      organization_id: organization.id,
      action_class: 'support_write',
      grant_kind: 'emergency',
      status: 'active',
      reason: 'production incident mitigation',
      requested_duration_seconds: 600,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      review_required: true,
    });

    await expect(
      ensureOrganizationAccess(await writeCtxWithStepUp(superadmin), organization.id)
    ).resolves.toBe('admin');
  });

  test('the fetch helper admits an allowlisted read when ON', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });

    await expect(
      ensureOrganizationAccessAndFetchOrg(
        { ...readCtx(admin), trpcPath: 'codeIndexing.search' },
        organization.id
      )
    ).resolves.toMatchObject({ id: organization.id });
  });

  test('ON reports not-allowlisted, not expired, when an old grant is expired', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
      status: 'expired',
    });

    await expect(
      resolveOrganizationAccess({ user: admin, trpcType: 'POST' }, organization.id, {
        surface: 'rest',
        supportKey: '/api/organizations/[id]/user-tokens',
        requiredActionClass: 'support_write',
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ supportAccessReason: 'support_access_not_allowlisted' }),
    });
  });

  test('ON reports action-class when a write is requested with only an active read grant', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const approver = await insertTestUser({ is_admin: true });
    await db.insert(support_access_grants).values({
      actor_kilo_user_id: admin.id,
      organization_id: organization.id,
      action_class: 'support_write',
      status: 'revoked',
      approved_by_kilo_user_id: approver.id,
      reason: 'older revoked write grant',
      requested_duration_seconds: 600,
      requested_at: past.toISOString(),
      issued_at: past.toISOString(),
      expires_at: new Date(past.getTime() + 10 * 60 * 1000).toISOString(),
      revoked_at: past.toISOString(),
      revoke_reason: 'older revoked write grant',
    });

    await expect(
      ensureOrganizationAccess(
        {
          user: admin,
          trpcPath: 'organizations.settings.updateDefaultModel',
          trpcType: 'mutation',
        },
        organization.id
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ supportAccessReason: 'support_access_action_class' }),
    });
  });

  test('ON fails closed when the membership read fails for an admin', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    const originalSelect = db.select.bind(db);
    const selectSpy = jest.spyOn(db, 'select').mockImplementation((...args) => {
      const builder = originalSelect(...args);
      return new Proxy(builder, {
        get(target, property, receiver) {
          if (property === 'from') {
            return (table: Parameters<typeof target.from>[0]) => {
              if (table === organization_memberships) {
                throw new Error('membership lookup failed');
              }
              return target.from(table);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    try {
      await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).rejects.toMatchObject(
        {
          code: 'FORBIDDEN',
          cause: expect.objectContaining({
            supportAccessReason: 'support_grant_lookup_failed',
          }),
        }
      );
    } finally {
      selectSpy.mockRestore();
    }
  });

  test('member-only never admits a grant but admits a real admin member', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });
    await expect(
      ensureMemberOrganizationAccess({ id: admin.id }, organization.id)
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: admin.id,
      role: 'admin',
      invited_by: 'test',
    });
    await expect(ensureMemberOrganizationAccess({ id: admin.id }, organization.id)).resolves.toBe(
      'admin'
    );
  });

  test('ON batch roles contain only real memberships', async () => {
    setSupportEnabled(true);
    const { organization, admin } = await orgAndAdmin();
    const other = await orgAndAdmin();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: admin.id,
      role: 'owner',
      invited_by: 'test',
    });

    const roles = await getOrganizationsAccessRoles({ user: admin } as TRPCContext, [
      organization.id,
      other.organization.id,
    ]);

    expect(roles.get(organization.id)).toBe('owner');
    expect(roles.has(other.organization.id)).toBe(false);
  });

  test('ON denies an active grant after the admin is demoted or blocked', async () => {
    setSupportEnabled(true);
    const demoted = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: demoted.admin.id,
      organizationId: demoted.organization.id,
      actionClass: 'support_read',
    });
    await db
      .update(kilocode_users)
      .set({ is_admin: false })
      .where(eq(kilocode_users.id, demoted.admin.id));
    const demotedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, demoted.admin.id),
    });
    await expect(
      ensureOrganizationAccess(readCtx(demotedUser!), demoted.organization.id)
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const blocked = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: blocked.admin.id,
      organizationId: blocked.organization.id,
      actionClass: 'support_read',
    });
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'test block' })
      .where(eq(kilocode_users.id, blocked.admin.id));
    const blockedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, blocked.admin.id),
    });
    await expect(
      ensureOrganizationAccess(readCtx(blockedUser!), blocked.organization.id)
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ supportAccessReason: 'support_grant_required' }),
    });
  });

  test('the fetch helper keeps the OFF owner shortcut', async () => {
    const { organization, admin } = await orgAndAdmin();
    await expect(
      ensureOrganizationAccessAndFetchOrg(
        { ...readCtx(admin), trpcPath: 'codeIndexing.search' },
        organization.id
      )
    ).resolves.toMatchObject({ id: organization.id });
    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({ reason: 'organization_fetch' });
  });

  test('platform operations record no support decision', async () => {
    const { organization, admin } = await orgAndAdmin();
    await requireLiveOrganizationForPlatformAdmin(readCtx(admin), organization.id, ['owner']);
    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({ reason: 'organization_access' });
    expect(event).toMatchObject({ supportDecision: null });
  });
});

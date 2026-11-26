import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { admin_action_audit_logs, organizations } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { defineTestUser, insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  addUserToOrganization,
  createOrganization,
} from '@kilocode/web-shared/lib/organizations/organizations';
import {
  addAdminAuditMetadata,
  adminActionContextFromHeaders,
  auditedAdminRoute,
  inputFieldTarget,
  isAuditedAdminRoute,
  organizationActionTarget,
  recordAdminAction,
  recordAdminActions,
  redactEmailAddressesInAuditText,
  runElevatedOrganizationWrite,
  setAdminActionSinkForTest,
  setAdminAuditActor,
  userActionTarget,
  type AdminActionContext,
  type AdminActionEvent,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';

function ctxFor(overrides: Partial<AdminActionContext> = {}): AdminActionContext {
  return {
    user: defineTestUser({ is_admin: true, is_super_admin: false }),
    authViaToken: false,
    tokenSource: null,
    ip: '203.0.113.7',
    trpcPath: 'admin.users.resetAPIKey',
    trpcType: 'mutation',
    ...overrides,
  };
}

describe('recordAdminAction', () => {
  let events: AdminActionEvent[];

  beforeEach(() => {
    events = [];
    setAdminActionSinkForTest(event => events.push(event));
  });

  afterEach(async () => {
    setAdminActionSinkForTest(null);
    await cleanupDbForTest();
  });

  test('inserts a row and emits a matching log event', async () => {
    const ctx = ctxFor();

    await recordAdminAction(ctx, {
      action: 'user.api_key.reset',
      target: userActionTarget('target-user'),
      message: 'Reset API key',
      metadata: { reason: 'support ticket' },
    });

    const rows = await db
      .select()
      .from(admin_action_audit_logs)
      .where(eq(admin_action_audit_logs.actor_id, ctx.user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'user.api_key.reset',
      actor_email: ctx.user.google_user_email,
      actor_name: ctx.user.google_user_name,
      target_type: 'user',
      target_id: 'target-user',
      message: 'Reset API key',
      metadata: { reason: 'support ticket' },
    });

    expect(events).toEqual([
      {
        event: 'admin_action',
        action: 'user.api_key.reset',
        outcome: 'success',
        auditLogId: rows[0]?.id,
        persisted: true,
        kiloUserId: ctx.user.id,
        email: ctx.user.google_user_email,
        adminTier: 'platform_admin',
        authVia: 'session',
        tokenSource: null,
        route: 'admin.users.resetAPIKey',
        ip: '203.0.113.7',
        targetType: 'user',
        targetId: 'target-user',
        message: 'Reset API key',
        metadata: { reason: 'support ticket' },
      },
    ]);
  });

  test('records actions without a target', async () => {
    await recordAdminAction(ctxFor(), {
      action: 'email_test.send',
      target: null,
      message: 'Sent test email',
    });

    const [row] = await db.select().from(admin_action_audit_logs);
    expect(row?.target_type).toBeNull();
    expect(row?.target_id).toBeNull();
    expect(events[0]).toMatchObject({ targetType: null, targetId: null, persisted: true });
  });

  test('still emits the log event, flagged unpersisted, when the insert fails', async () => {
    const insert = jest.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    try {
      await expect(
        recordAdminAction(ctxFor({ authViaToken: true, tokenSource: 'cloud-agent' }), {
          action: 'organization.delete',
          target: organizationActionTarget('org-1'),
          message: 'Deleted organization',
        })
      ).resolves.toBeUndefined();
    } finally {
      insert.mockRestore();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'organization.delete',
      persisted: false,
      auditLogId: null,
      authVia: 'token',
      tokenSource: 'cloud-agent',
    });
  });

  test('records one row per entry and one log line per insert chunk', async () => {
    const userIds = Array.from({ length: 1_001 }, (_, index) => `bulk-user-${index}`);

    await recordAdminActions(
      ctxFor(),
      userIds.map(userId => ({
        action: 'user.unblock' as const,
        target: userActionTarget(userId),
        message: 'Unblocked user via bulk unblock',
        metadata: { bulk: true, userId },
      }))
    );

    const rows = await db
      .select({ id: admin_action_audit_logs.id, target_id: admin_action_audit_logs.target_id })
      .from(admin_action_audit_logs);
    expect(rows.map(row => row.target_id).sort()).toEqual([...userIds].sort());

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event: 'admin_action',
      action: 'user.unblock',
      outcome: 'success',
      entryCount: 1_000,
      persisted: true,
      route: 'admin.users.resetAPIKey',
      targetType: 'user',
      targetIds: userIds.slice(0, 1_000),
      message: 'Unblocked user via bulk unblock',
      // Each entry carries its own metadata, so the line names none.
      metadata: null,
    });
    expect(events[1]).toMatchObject({ entryCount: 1, targetIds: [userIds[1_000]] });
    const loggedIds = events.flatMap(event => ('auditLogIds' in event ? event.auditLogIds : []));
    expect([...loggedIds].sort()).toEqual(rows.map(row => row.id).sort());
    expect(Math.max(...events.map(event => JSON.stringify(event).length))).toBeLessThan(128_000);
  });

  test('splits a bulk log line by action and outcome', async () => {
    await recordAdminActions(ctxFor(), [
      { action: 'user.unblock', target: userActionTarget('user-1'), message: 'Unblocked' },
      {
        action: 'user.unblock',
        outcome: 'failure',
        errorCode: 'Error',
        target: userActionTarget('user-2'),
        message: 'Unblock failed',
      },
      { action: 'user.unblock', target: organizationActionTarget('org-3'), message: 'Unblocked' },
    ]);

    expect(events).toEqual([
      expect.objectContaining({
        outcome: 'success',
        entryCount: 2,
        targetType: null,
        targetIds: ['user-1', 'org-3'],
        message: 'Unblocked',
      }),
      expect.objectContaining({
        outcome: 'failure',
        entryCount: 1,
        targetType: 'user',
        targetIds: ['user-2'],
        metadata: { errorCode: 'Error' },
      }),
    ]);
  });

  test('does nothing for an empty batch', async () => {
    await recordAdminActions(ctxFor(), []);

    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe('adminActionContextFromHeaders', () => {
  let events: AdminActionEvent[];

  beforeEach(() => {
    events = [];
    setAdminActionSinkForTest(event => events.push(event));
  });

  afterEach(async () => {
    setAdminActionSinkForTest(null);
    await cleanupDbForTest();
  });

  test('attributes the REST route from the request headers', async () => {
    const ctx = adminActionContextFromHeaders(
      defineTestUser({ is_admin: true }),
      new Headers({
        'x-pathname': '/api/organizations/org_1/user-tokens',
      })
    );

    await recordAdminAction(ctx, {
      action: 'organization.token.mint',
      target: organizationActionTarget('org_1'),
      message: 'Minted token from REST route',
    });

    expect(events).toHaveLength(1);
    expect(events[0].route).toBe('/api/organizations/org_1/user-tokens');
  });

  test('keeps a caller-supplied path over the request headers', async () => {
    const ctx = {
      ...adminActionContextFromHeaders(
        defineTestUser({ is_admin: true }),
        new Headers({ 'x-pathname': '/api/organizations/org_1/user-tokens' })
      ),
      trpcPath: '/admin/api/api-request-log/download',
    };

    await recordAdminAction(ctx, {
      action: 'organization.token.mint',
      target: organizationActionTarget('org_1'),
      message: 'Downloaded request log',
    });

    expect(events).toHaveLength(1);
    expect(events[0].route).toBe('/admin/api/api-request-log/download');
  });
});

describe('redactEmailAddressesInAuditText', () => {
  test('replaces ASCII and non-ASCII addresses and leaves other text alone', () => {
    expect(
      redactEmailAddressesInAuditText(
        'chargeback, contacted by victim@example.com and josé.muñoz@example.co.uk'
      )
    ).toBe('chargeback, contacted by [redacted-email] and [redacted-email]');

    expect(redactEmailAddressesInAuditText('politique: jean-zoe\u0301@example.com')).toBe(
      'politique: [redacted-email]'
    );

    expect(redactEmailAddressesInAuditText("blocked after o'brien@example.com wrote in")).toBe(
      'blocked after [redacted-email] wrote in'
    );

    expect(redactEmailAddressesInAuditText('policy violation, tier_19, 2nd offence')).toBe(
      'policy violation, tier_19, 2nd offence'
    );
  });

  test('keeps the bracket or quote around a pasted address', () => {
    expect(redactEmailAddressesInAuditText('see (victim@example.com) in the thread')).toBe(
      'see ([redacted-email]) in the thread'
    );

    expect(redactEmailAddressesInAuditText('quoted "victim@example.com" here')).toBe(
      'quoted "[redacted-email]" here'
    );

    expect(redactEmailAddressesInAuditText('list: <victim@example.com>, ok')).toBe(
      'list: <[redacted-email]>, ok'
    );
  });

  test('keeps prose punctuation that runs into a pasted address', () => {
    expect(redactEmailAddressesInAuditText('refund for ...victim@example.com')).toBe(
      'refund for ...[redacted-email]'
    );

    expect(redactEmailAddressesInAuditText('blocked -victim@example.com for fraud')).toBe(
      'blocked -[redacted-email] for fraud'
    );

    expect(redactEmailAddressesInAuditText('watch victim@example.com! and ?two/more')).toBe(
      'watch [redacted-email]! and ?two/more'
    );

    expect(redactEmailAddressesInAuditText('forward /victim@example.com to abuse')).toBe(
      'forward /[redacted-email] to abuse'
    );
  });

  test('leaves host forms without a dotted domain alone', () => {
    expect(redactEmailAddressesInAuditText('intranet user@localhost and user@[192.0.2.1]')).toBe(
      'intranet user@localhost and user@[192.0.2.1]'
    );
  });
});

describe('runElevatedOrganizationWrite', () => {
  beforeEach(() => setAdminActionSinkForTest(() => {}));
  afterEach(async () => {
    setAdminActionSinkForTest(null);
    await cleanupDbForTest();
  });

  async function adminWithInheritedOwnerRole() {
    const admin = await insertTestUser({ is_admin: true });
    const parent = await createOrganization('Parent Org', admin.id);
    const child = await createOrganization('Child Org', null);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    return { admin, childId: child.id };
  }

  function write<TResult>(
    user: Awaited<ReturnType<typeof insertTestUser>>,
    organizationId: string,
    run: () => Promise<TResult>,
    scope?: 'direct'
  ) {
    return runElevatedOrganizationWrite(
      { ...ctxFor(), user },
      {
        organizationId,
        requiredRoles: ['owner'],
        membershipScope: scope,
        action: 'organization.gitlab_webhook_secret.rotate',
        message: 'GitLab webhook secret: rotate',
      },
      run
    );
  }

  const succeed = async () => 'done';

  test('an inherited owner role satisfies inherited-scope guards but not direct-only guards', async () => {
    const { admin, childId } = await adminWithInheritedOwnerRole();

    await write(admin, childId, succeed);
    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);

    await expect(write(admin, childId, succeed, 'direct')).resolves.toBe('done');
    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({ outcome: 'success', metadata: { heldRoles: [] } }),
    ]);
  });

  test('records nothing for non-admins or admins holding a sufficient role, even when the write fails', async () => {
    const owner = await insertTestUser({ is_admin: false });
    const organization = await createOrganization('Owned Org', owner.id);
    const adminOwner = await insertTestUser({ is_admin: true });
    await addUserToOrganization(organization.id, adminOwner.id, 'owner');
    const fail = async () => {
      throw new TRPCError({ code: 'NOT_FOUND' });
    };

    await write(owner, organization.id, succeed);
    await write(adminOwner, organization.id, succeed, 'direct');
    await expect(write(owner, organization.id, fail)).rejects.toThrow(TRPCError);
    await expect(write(adminOwner, organization.id, fail)).rejects.toThrow(TRPCError);

    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);
  });

  test('a failed write records a failure row with its code and the metadata it added, then rethrows', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const organizationId = crypto.randomUUID();
    const error = new TRPCError({ code: 'PRECONDITION_FAILED', message: 'secret text' });

    await expect(
      write(admin, organizationId, async () => {
        addAdminAuditMetadata({ integrationId: 'integration-1' });
        throw error;
      })
    ).rejects.toBe(error);

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'organization.gitlab_webhook_secret.rotate',
        outcome: 'failure',
        target_type: 'organization',
        target_id: organizationId,
        metadata: {
          integrationId: 'integration-1',
          heldRoles: [],
          errorCode: 'PRECONDITION_FAILED',
        },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('secret text');
  });

  test.each([
    ['a 4xx status', Response.json({ error: 'nope' }, { status: 403 }), 'failure', '403'],
    [
      'a redirect carrying an error code',
      Response.redirect('http://localhost/integrations?error=installation_failed', 302),
      'failure',
      'installation_failed',
    ],
    [
      'a redirect carrying provider free text',
      Response.redirect('http://localhost/integrations?error=The%20user%20said%20no', 302),
      'failure',
      'redirect_error',
    ],
    [
      'a success redirect',
      Response.redirect('http://localhost/integrations?success=installed', 302),
      'success',
      undefined,
    ],
  ])('judges a response with %s', async (_label, response, outcome, errorCode) => {
    const admin = await insertTestUser({ is_admin: true });

    await expect(write(admin, crypto.randomUUID(), async () => response)).resolves.toBe(response);

    const [row] = await db.select().from(admin_action_audit_logs);
    expect(row?.outcome).toBe(outcome);
    expect(row?.metadata).toEqual({ heldRoles: [], ...(errorCode ? { errorCode } : {}) });
  });

  test('records with unknown held roles instead of throwing when the membership lookup fails', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const select = jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    try {
      await expect(write(admin, crypto.randomUUID(), succeed)).resolves.toBe('done');
    } finally {
      select.mockRestore();
    }

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ heldRoles: null });
  });
});

describe('auditedAdminRoute', () => {
  const admin = defineTestUser({ is_admin: true, is_super_admin: false });
  const path = '/admin/api/users/user-1/kill-balance-cache';
  const routeContext = { params: Promise.resolve({ id: 'user-1' }) };
  type RouteContext = typeof routeContext;
  let events: AdminActionEvent[];

  beforeEach(() => {
    events = [];
    setAdminActionSinkForTest(event => events.push(event));
  });

  afterEach(async () => {
    setAdminActionSinkForTest(null);
    await cleanupDbForTest();
  });

  function request() {
    return new Request(`http://localhost:3000${path}`, {
      method: 'POST',
      headers: { 'x-vercel-forwarded-for': '198.51.100.4' },
    });
  }

  const unblockUser = {
    kind: 'declarative',
    action: 'user.unblock',
    target: inputFieldTarget('user', 'id'),
  } as const;

  test('records one success row with the target from the route params', async () => {
    const POST = auditedAdminRoute(unblockUser, async (_request: Request, _ctx: RouteContext) => {
      setAdminAuditActor(admin);
      return Response.json({ ok: true });
    });

    expect((await POST(request(), routeContext)).status).toBe(200);

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'user.unblock',
        outcome: 'success',
        actor_id: admin.id,
        target_type: 'user',
        target_id: 'user-1',
        message: path,
        metadata: null,
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({ outcome: 'success', route: path, ip: '198.51.100.4' }),
    ]);
  });

  test('records a status of 400 or above as a failure and returns the response unchanged', async () => {
    const refusal = Response.json({ error: 'Credit management access required' }, { status: 403 });
    const POST = auditedAdminRoute(unblockUser, async (_request: Request, _ctx: RouteContext) => {
      setAdminAuditActor(admin);
      return refusal;
    });

    await expect(POST(request(), routeContext)).resolves.toBe(refusal);

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'user.unblock',
        outcome: 'failure',
        target_id: 'user-1',
        metadata: { errorCode: '403' },
      }),
    ]);
    expect(events[0]).toMatchObject({ outcome: 'failure', metadata: { errorCode: '403' } });
  });

  test('records a throw as a failure without its message and rethrows the same error', async () => {
    const failure = new Error('balance cache for someone@customer.test is unreachable');
    const POST = auditedAdminRoute(unblockUser, async (_request: Request, _ctx: RouteContext) => {
      setAdminAuditActor(admin);
      addAdminAuditMetadata({ attempt: 2 });
      throw failure;
    });

    await expect(POST(request(), routeContext)).rejects.toBe(failure);

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'failure',
      metadata: { attempt: 2, errorCode: 'Error' },
    });
    expect(JSON.stringify(rows)).not.toContain('customer.test');
    expect(JSON.stringify(events)).not.toContain('customer.test');
  });

  test('records nothing for a failure before the handler named its admin', async () => {
    const POST = auditedAdminRoute(unblockUser, async (_request: Request, _ctx: RouteContext) =>
      Response.json({ error: 'Unauthorized' }, { status: 401 })
    );

    expect((await POST(request(), routeContext)).status).toBe(401);
    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);
  });

  test('reports a success that never named its admin', async () => {
    const POST = auditedAdminRoute(unblockUser, async (_request: Request, _ctx: RouteContext) =>
      Response.json({ ok: true })
    );

    await expect(POST(request(), routeContext)).rejects.toThrow('Admin audit gap');
  });

  test('brands the wrapped handler without an enumerable key', () => {
    const POST = auditedAdminRoute(unblockUser, async (_request: Request) => new Response());

    expect(isAuditedAdminRoute(POST)).toBe(true);
    expect(Object.keys(POST)).toEqual([]);
    expect(isAuditedAdminRoute(async (_request: Request) => new Response())).toBe(false);
  });
});

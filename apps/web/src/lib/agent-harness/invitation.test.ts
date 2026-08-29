import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  agent_harness_clients,
  agent_harness_conversation_grants,
  agent_harness_conversation_registry,
  agent_harness_invitation_results,
  agent_harness_retirements,
  deleted_user_email_tombstones,
  external_side_effect_outbox,
  kilocode_users,
  organization_audit_logs,
  organization_invitations,
  organization_memberships,
  organization_seats_purchases,
  organizations,
  quick_chat_threads,
  type Organization,
  type OrganizationInvitation,
  type User,
} from '@kilocode/db/schema';
import type * as DatabaseModule from '@/lib/drizzle';
import type * as OrganizationsModule from '@/lib/organizations/organizations';
import type * as MemberInvitationModule from '@/lib/organizations/member-invitation';
import type * as AccessModule from '@/routers/organizations/utils';
import type * as TrialModule from '@/lib/organizations/trial-middleware';
import type * as OutboxModule from '@kilocode/db/external-side-effect-outbox';
import type * as AuthorizationModule from './authorization';
import type * as InvitationModule from './invitation';
import type * as RetirementModule from './retirement';
import type { OrganizationRole } from '@/lib/organizations/organization-types';

const organizationId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const invocation = {
  conversationId,
  operationId,
  arguments: { recipient: 'New.Member@example.com', role: 'member' },
};

// These tests prove validation and legacy mapping only, not transactions or live effects.
describe('invitation pure', () => {
  let member: typeof MemberInvitationModule;
  let adapter: typeof InvitationModule;
  const access = jest.fn<typeof AccessModule.ensureOrganizationAccess>();
  const trial = jest.fn<typeof TrialModule.requireActiveSubscriptionOrTrial>();
  const lookup = jest.fn<typeof OrganizationsModule.getOrganizationById>();
  const invite = jest.fn<typeof OrganizationsModule.inviteUserToOrganization>();
  const enqueue = jest.fn<typeof OutboxModule.enqueueInviteEmail>();
  const authorize = jest.fn<typeof AuthorizationModule.authorizeHarnessCapability>();
  const actor = {
    id: 'oauth/github:inviter',
    google_user_email: 'actor@example.com',
    google_user_name: 'Actor',
  } as User;
  const invitation = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
  } as OrganizationInvitation;
  const mockedPaths = [
    '@/lib/drizzle',
    '@/lib/organizations/organizations',
    '@/routers/organizations/utils',
    '@/lib/organizations/trial-middleware',
    '@/lib/organizations/organization-audit-logs',
    '@kilocode/db/external-side-effect-outbox',
    './authorization',
    './clients',
  ];

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('@/lib/drizzle', () => ({
        db: {
          transaction: async (work: (tx: DatabaseModule.DrizzleTransaction) => Promise<unknown>) =>
            work({} as DatabaseModule.DrizzleTransaction),
        },
      }));
      jest.doMock('@/lib/organizations/organizations', () => ({
        getOrganizationById: lookup,
        inviteUserToOrganization: invite,
        getAcceptInviteUrl: (token: string) => `https://example.com/users/accept-invite/${token}`,
      }));
      jest.doMock('@/routers/organizations/utils', () => ({ ensureOrganizationAccess: access }));
      jest.doMock('@/lib/organizations/trial-middleware', () => ({
        requireActiveSubscriptionOrTrial: trial,
      }));
      jest.doMock('@/lib/organizations/organization-audit-logs', () => ({
        createAuditLog: async () => undefined,
      }));
      jest.doMock('@kilocode/db/external-side-effect-outbox', () => ({
        enqueueInviteEmail: enqueue,
      }));
      jest.doMock('./authorization', () => ({
        authorizeHarnessCapability: authorize,
        harnessInputDigest: () => '0'.repeat(64),
      }));
      jest.doMock('./clients', () => ({
        harnessAccessDenied: () => {
          throw new Error('Unexpected primary access');
        },
      }));
      member = jest.requireActual<typeof MemberInvitationModule>(
        '@/lib/organizations/member-invitation'
      );
      adapter = jest.requireActual<typeof InvitationModule>('./invitation');
    });
  });
  afterAll(() => {
    for (const path of mockedPaths) jest.dontMock(path);
  });
  beforeEach(() => {
    access.mockReset().mockResolvedValue('owner');
    trial.mockReset().mockResolvedValue({ isReadOnly: false, daysRemaining: 7 });
    lookup
      .mockReset()
      .mockResolvedValue({ id: organizationId, name: 'Organization' } as Organization);
    invite.mockReset().mockResolvedValue(invitation);
    enqueue.mockReset().mockResolvedValue({} as Awaited<ReturnType<typeof enqueue>>);
    authorize
      .mockReset()
      .mockRejectedValue(new Error('Capability must not be reached for invalid input'));
  });
  const send = (role: OrganizationRole = 'member') =>
    member.inviteOrganizationMember(
      { user: actor },
      { organizationId, email: invocation.arguments.recipient, role }
    );

  it('keeps the legacy URL, invitation reference, and pending email response', async () => {
    expect(await send()).toEqual({
      acceptInviteUrl: `https://example.com/users/accept-invite/${invitation.token}`,
      invitationId: invitation.id,
      emailStatus: 'pending',
    });
  });
  it.each([
    [
      'User already has a pending invitation',
      'CONFLICT',
      'This email already has a pending invitation',
    ],
    [
      'User is already a member of this organization',
      'CONFLICT',
      'This user is already a member of this organization',
    ],
    [
      'Child organizations cannot invite members',
      'PRECONDITION_FAILED',
      'Child organizations manage membership through their parent organization.',
    ],
    [
      'User must join this organization through SSO',
      'FORBIDDEN',
      'This user must join through your organization SSO provider',
    ],
    [
      'Organization SSO policy is misconfigured',
      'PRECONDITION_FAILED',
      'This organization has an invalid SSO configuration',
    ],
  ])('preserves the legacy mapping for %s', async (source, code, message) => {
    invite.mockRejectedValueOnce(new Error(source));
    await expect(send()).rejects.toMatchObject({ code, message });
  });
  it('preserves an unknown transaction failure instead of reporting success', async () => {
    const error = new Error('Database unavailable');
    invite.mockRejectedValueOnce(error);
    await expect(send()).rejects.toBe(error);
  });
  it('does not report queue success when enqueue fails', async () => {
    const error = new Error('Queue insert failed');
    enqueue.mockRejectedValueOnce(error);
    await expect(send()).rejects.toBe(error);
  });
  it('retains billing authorization and trial failures', async () => {
    const denied = new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });
    access.mockRejectedValueOnce(denied);
    await expect(send()).rejects.toBe(denied);
    const expired = new TRPCError({
      code: 'FORBIDDEN',
      message: 'Organization trial has expired.',
    });
    trial.mockRejectedValueOnce(expired);
    await expect(send()).rejects.toBe(expired);
  });
  it('requires management authority for an elevated invitation', async () => {
    access
      .mockResolvedValueOnce('billing_manager')
      .mockRejectedValueOnce(new TRPCError({ code: 'UNAUTHORIZED' }));
    await expect(send('admin')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('refuses an admin inviting an owner', async () => {
    access.mockResolvedValue('admin');
    await expect(send('owner')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only an organization owner can manage owners',
    });
  });
  it('preserves the missing organization error', async () => {
    lookup.mockResolvedValueOnce(null);
    await expect(send()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Organization not found',
    });
  });
  it.each([
    ['recipient', { ...invocation, arguments: { recipient: 'not-email', role: 'member' } }],
    ['role', { ...invocation, arguments: { recipient: 'new@example.com', role: 'super_admin' } }],
    ['missing role', { ...invocation, arguments: { recipient: 'new@example.com' } }],
    ['actor', { ...invocation, actorUserId: 'another-user' }],
    ['organization', { ...invocation, organizationId }],
    ['endpoint', { ...invocation, path: 'organizations.members.invite' }],
    [
      'argument actor',
      { ...invocation, arguments: { ...invocation.arguments, actorUserId: 'another-user' } },
    ],
    ['operation', { ...invocation, operationId: 'invalid' }],
    ['conversation', { ...invocation, conversationId: 'invalid' }],
    ['missing operation', { conversationId, arguments: invocation.arguments }],
  ])('rejects invalid or caller-selected %s before authority or effects', async (_name, input) => {
    await expect(adapter.executeHarnessInvitation('token', input)).rejects.toMatchObject({
      name: 'ZodError',
    });
    await expect(adapter.reconcileHarnessInvitation('token', input)).rejects.toMatchObject({
      name: 'ZodError',
    });
  });
  it('bounds harness input without imposing that limit on the legacy operation', async () => {
    const email = `${'a'.repeat(64 * 1024)}@example.com`;
    await expect(
      adapter.executeHarnessInvitation('token', {
        ...invocation,
        arguments: { recipient: email, role: 'member' },
      })
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await expect(
      member.inviteOrganizationMember({ user: actor }, { organizationId, email, role: 'member' })
    ).resolves.toMatchObject({ invitationId: invitation.id });
  });
  it('refuses a Personal conversation without opening a mutation transaction', async () => {
    authorize.mockResolvedValueOnce({ authority: { organizationId: null } } as Awaited<
      ReturnType<typeof authorize>
    >);
    await expect(adapter.executeHarnessInvitation('token', invocation)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Invitations require an organization conversation',
    });
  });
});

// Ordinary web CI executes these real SQL cases. The local pure filter excludes this suite's hooks.
describe('invitation PostgreSQL', () => {
  let db: typeof DatabaseModule.db;
  let pool: typeof DatabaseModule.pool;
  let adapter: typeof InvitationModule;
  let authorization: typeof AuthorizationModule;
  let retirement: typeof RetirementModule;
  let enqueue: jest.MockedFunction<typeof OutboxModule.enqueueInviteEmail>;
  let realEnqueue: typeof OutboxModule.enqueueInviteEmail;
  let owner: User;
  let organization: Organization;
  let threadId: string;
  let clientId: string;
  let grantId: string;
  let input: {
    conversationId: string;
    operationId: string;
    arguments: { recipient: string; role: OrganizationRole };
  };
  let token: string;
  let userIds: string[] = [];
  let organizationIds: string[] = [];
  let threadIds: string[] = [];

  beforeAll(async () => {
    ({ db, pool } = await import('@/lib/drizzle'));
    const outbox = jest.requireActual<typeof OutboxModule>(
      '@kilocode/db/external-side-effect-outbox'
    );
    realEnqueue = outbox.enqueueInviteEmail;
    enqueue = jest.fn(realEnqueue);
    jest.doMock('@kilocode/db/external-side-effect-outbox', () => ({
      ...outbox,
      enqueueInviteEmail: enqueue,
    }));
    adapter = await import('./invitation');
    authorization = await import('./authorization');
    retirement = await import('./retirement');
  });
  beforeEach(async () => {
    enqueue.mockReset().mockImplementation(realEnqueue);
    userIds = [`oauth/github:${crypto.randomUUID()}`];
    organizationIds = [crypto.randomUUID()];
    threadIds = [crypto.randomUUID()];
    threadId = threadIds[0];
    clientId = crypto.randomUUID();
    grantId = crypto.randomUUID();
    [owner] = await db
      .insert(kilocode_users)
      .values({
        id: userIds[0],
        google_user_email: `${crypto.randomUUID()}@example.com`,
        google_user_name: 'Invitation owner',
        google_user_image_url: '',
        stripe_customer_id: `cus_${crypto.randomUUID()}`,
      })
      .returning();
    [organization] = await db
      .insert(organizations)
      .values({
        id: organizationIds[0],
        name: `Harness invitation ${organizationIds[0]}`,
        created_by_kilo_user_id: owner.id,
        free_trial_end_at: sql`clock_timestamp() + interval '1 day'`,
      })
      .returning();
    await db
      .insert(organization_memberships)
      .values({ organization_id: organization.id, kilo_user_id: owner.id, role: 'owner' });
    await db
      .insert(quick_chat_threads)
      .values({ id: threadId, user_id: owner.id, organization_id: organization.id });
    await db.insert(agent_harness_conversation_registry).values({
      thread_id: threadId,
      user_id: owner.id,
      organization_id: organization.id,
      generation: 0,
    });
    await db.insert(agent_harness_clients).values({
      id: clientId,
      user_id: owner.id,
      kind: 'mobile',
      session_binding: 'invitation-test-session',
    });
    await db.insert(agent_harness_conversation_grants).values({
      id: grantId,
      thread_id: threadId,
      user_id: owner.id,
      client_id: clientId,
      generation: 0,
      expires_at: sql`clock_timestamp() + interval '1 hour'`,
    });
    input = {
      conversationId: threadId,
      operationId: crypto.randomUUID(),
      arguments: { recipient: `${crypto.randomUUID()}@example.com`, role: 'member' },
    };
    token = await mint(input);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!db) return;
    // The unique fixture name also finds orphan queue rows after an invitation deletion or faulty rollback.
    if (organization)
      await db
        .delete(external_side_effect_outbox)
        .where(
          eq(sql`${external_side_effect_outbox.payload}->>'organizationName'`, organization.name)
        );
    await db.delete(quick_chat_threads).where(inArray(quick_chat_threads.id, threadIds));
    await db
      .delete(agent_harness_conversation_registry)
      .where(inArray(agent_harness_conversation_registry.thread_id, threadIds));
    await db
      .delete(agent_harness_retirements)
      .where(inArray(agent_harness_retirements.thread_id, threadIds));
    await db
      .delete(organization_invitations)
      .where(inArray(organization_invitations.organization_id, organizationIds));
    await db
      .delete(organization_audit_logs)
      .where(inArray(organization_audit_logs.organization_id, organizationIds));
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, organizationIds));
    await db.delete(organizations).where(inArray(organizations.id, organizationIds));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
    if (owner) {
      const { hashNormalizedEmailForDeletionTombstone } = await import('@/lib/impact/referral');
      await db
        .delete(deleted_user_email_tombstones)
        .where(
          eq(
            deleted_user_email_tombstones.normalized_email_hash,
            hashNormalizedEmailForDeletionTombstone(owner.google_user_email)
          )
        );
    }
  });
  afterAll(() => {
    jest.dontMock('@kilocode/db/external-side-effect-outbox');
  });

  function mint(request = input) {
    return authorization.mintHarnessCapability(grantId, {
      audience: 'agent-harness:operations',
      conversationId: request.conversationId,
      operation: 'kilo.invite',
      definitionVersion: '1',
      inputDigest: authorization.harnessInputDigest(request.arguments),
      dispatchId: request.operationId,
      target: { kind: 'backend' },
    });
  }
  const execute = () => adapter.executeHarnessInvitation(token, input);
  const reconcile = () => adapter.reconcileHarnessInvitation(token, input);
  async function effects() {
    const [invitations, audits, outbox, operations] = await Promise.all([
      db
        .select()
        .from(organization_invitations)
        .where(inArray(organization_invitations.organization_id, organizationIds))
        .orderBy(organization_invitations.id),
      db
        .select()
        .from(organization_audit_logs)
        .where(
          and(
            inArray(organization_audit_logs.organization_id, organizationIds),
            eq(organization_audit_logs.action, 'organization.user.send_invite')
          )
        )
        .orderBy(organization_audit_logs.id),
      db
        .select()
        .from(external_side_effect_outbox)
        .where(
          eq(sql`${external_side_effect_outbox.payload}->>'organizationName'`, organization.name)
        )
        .orderBy(external_side_effect_outbox.id),
      db
        .select()
        .from(agent_harness_invitation_results)
        .where(inArray(agent_harness_invitation_results.thread_id, threadIds))
        .orderBy(agent_harness_invitation_results.operation_id),
    ]);
    return { invitations, audits, outbox, operations };
  }
  async function expectNoEffects() {
    expect(await effects()).toEqual({ invitations: [], audits: [], outbox: [], operations: [] });
  }
  async function changeRole(role: OrganizationRole) {
    await db
      .update(organization_memberships)
      .set({ role })
      .where(
        and(
          eq(organization_memberships.organization_id, organization.id),
          eq(organization_memberships.kilo_user_id, owner.id)
        )
      );
  }

  // Hold the real first transaction before commit until PostgreSQL proves the second transaction waits.
  async function race<A, B>(
    first: () => Promise<A>,
    second: () => Promise<B>,
    beforeRelease?: (tx: DatabaseModule.DrizzleTransaction) => void | Promise<void>
  ) {
    const transaction = db.transaction.bind(db);
    let competing: Promise<PromiseSettledResult<B>[]> | undefined;
    const held = jest.spyOn(db, 'transaction').mockImplementationOnce(work =>
      transaction(async tx => {
        const result = await work(tx);
        const { rows: sessions } = await tx.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`
        );
        competing = Promise.allSettled([second()]);
        let blocked = false;
        const deadline = Date.now() + 5_000;
        while (!blocked && Date.now() < deadline) {
          const { rows } = await pool.query<{ blocked: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND $1::integer = ANY(pg_blocking_pids(pid))) AS blocked`,
            [sessions[0].pid]
          );
          blocked = rows[0].blocked;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await beforeRelease?.(tx);
        return result;
      })
    );
    try {
      const firstResult = await first();
      if (!competing) throw new Error('The competing transaction did not start');
      const [secondResult] = await competing;
      return { firstResult, secondResult };
    } finally {
      held.mockRestore();
      await competing;
    }
  }

  it('uses transaction-local direct and inherited roles without changing priority or errors', async () => {
    const { ensureOrganizationAccess } = await import('@/routers/organizations/utils');
    const childId = crypto.randomUUID();
    organizationIds.push(childId);
    await db.transaction(async tx => {
      await tx.insert(organizations).values({
        id: childId,
        name: 'Transaction-local child',
        parent_organization_id: organization.id,
      });
      await tx.insert(organization_memberships).values({
        organization_id: childId,
        kilo_user_id: owner.id,
        role: 'admin',
      });
      const ctx = { user: owner };
      expect(await ensureOrganizationAccess(ctx, childId, undefined, tx)).toBe('owner');
      expect(await ensureOrganizationAccess(ctx, childId, [], tx)).toBe('owner');
      expect(await ensureOrganizationAccess(ctx, childId, ['admin'], tx)).toBe('admin');
      await expect(ensureOrganizationAccess(ctx, childId, ['member'], tx)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      });
      await tx
        .update(organization_memberships)
        .set({ role: 'member' })
        .where(eq(organization_memberships.organization_id, organization.id));
      expect(await ensureOrganizationAccess(ctx, childId, undefined, tx)).toBe('admin');
      await tx
        .delete(organization_memberships)
        .where(eq(organization_memberships.organization_id, childId));
      await expect(ensureOrganizationAccess(ctx, childId, undefined, tx)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this organization',
      });
      await tx.delete(organizations).where(eq(organizations.id, childId));
    });
  });

  it('classifies transaction-local trial and seat changes before an invitation', async () => {
    const { requireActiveSubscriptionOrTrial } =
      await import('@/lib/organizations/trial-middleware');
    await db.transaction(async tx => {
      await tx
        .update(organizations)
        .set({ free_trial_end_at: '2000-01-01 00:00:00+00', require_seats: true })
        .where(eq(organizations.id, organization.id));
      await expect(requireActiveSubscriptionOrTrial(organization.id, tx)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Organization trial has expired.',
      });
      await tx.insert(organization_seats_purchases).values({
        organization_id: organization.id,
        subscription_stripe_id: `sub_${crypto.randomUUID()}`,
        subscription_status: 'active',
        seat_count: 1,
        amount_usd: 10,
        starts_at: sql`clock_timestamp()`,
        expires_at: sql`clock_timestamp() + interval '30 days'`,
      });
      await expect(requireActiveSubscriptionOrTrial(organization.id, tx)).resolves.toEqual({
        isReadOnly: false,
        daysRemaining: Infinity,
      });
    });
  });

  it.each(['execute', 'reconcile'] as const)(
    'completes %s while every other primary pool connection is occupied',
    async mode => {
      // Exercise both billing and management authorization, as well as the trial/seat lookup.
      input.arguments.role = 'owner';
      token = await mint();
      const recorded = mode === 'reconcile' ? await execute() : null;
      const baseline = recorded ? await effects() : null;
      const max = pool.options.max;
      if (!max) throw new Error('The primary pool must have an explicit connection limit');
      const clients: { release(): void }[] = [];
      let pending: ReturnType<typeof reconcile> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        for (let index = 1; index < max; index++) clients.push(await pool.connect());
        pending = mode === 'execute' ? execute() : reconcile();
        const result = await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Invitation waits for another connection')),
              5_000
            );
          }),
        ]);
        expect(result).toMatchObject({ emailQueued: true });
        if (recorded) expect(result).toEqual(recorded);
      } finally {
        clearTimeout(timer);
        for (const client of clients) client.release();
        if (pending) await Promise.allSettled([pending]);
      }
      const stored = await effects();
      for (const rows of Object.values(stored)) expect(rows).toHaveLength(1);
      expect(stored.invitations[0].role).toBe('owner');
      if (baseline) expect(stored).toEqual(baseline);
    },
    15_000
  );

  it.each([
    ['deletion', 'execute'],
    ['deletion', 'reconcile'],
    ['invitation', 'execute'],
    ['invitation', 'reconcile'],
  ] as const)(
    'serializes account deletion with %s admitted first during %s',
    async (first, mode) => {
      const { anonymizeCloudUserData } = await import('@/lib/user');
      const recorded = mode === 'reconcile' ? await execute() : null;
      const run = mode === 'execute' ? execute : reconcile;
      if (first === 'deletion') {
        // Pause at deletion's first user lock, before it changes the committed authority or locks threads.
        const { secondResult } = await race(
          () =>
            db.transaction(async tx => {
              await tx
                .select({ id: kilocode_users.id })
                .from(kilocode_users)
                .where(eq(kilocode_users.id, owner.id))
                .for('update');
            }),
          run,
          tx => anonymizeCloudUserData(tx, owner.id)
        );
        // A deadlock victim is not an authorization refusal, even if deletion happens to commit.
        expect(secondResult).toMatchObject({ status: 'rejected', reason: { code: 'FORBIDDEN' } });
      } else {
        const { firstResult, secondResult } = await race(run, () =>
          db.transaction(tx => anonymizeCloudUserData(tx, owner.id))
        );
        expect(firstResult).toMatchObject({ emailQueued: true });
        if (recorded) expect(firstResult).toEqual(recorded);
        expect(secondResult).toEqual({ status: 'fulfilled', value: undefined });
      }
      const stored = await effects();
      expect(stored.invitations).toEqual([]);
      expect(stored.outbox).toEqual([]);
      expect(stored.operations).toEqual([]);
      expect(stored.audits).toEqual(
        recorded || first === 'invitation'
          ? [expect.objectContaining({ actor_id: owner.id, actor_email: null, actor_name: null })]
          : []
      );
      expect(
        await db.query.kilocode_users.findFirst({ where: eq(kilocode_users.id, owner.id) })
      ).toMatchObject({
        google_user_email: `deleted+${owner.id}@deleted.invalid`,
        google_user_name: 'Deleted User',
        blocked_reason: expect.stringContaining('soft-deleted'),
      });
      expect(
        await db
          .select()
          .from(agent_harness_retirements)
          .where(eq(agent_harness_retirements.thread_id, threadId))
      ).toEqual([expect.objectContaining({ generation: 0, reason: 'account_deleted' })]);
      await expect(execute()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(reconcile()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    },
    15_000
  );

  it('commits one invitation, audit, queue entry, and canonical operation with the current actor', async () => {
    await db
      .update(kilocode_users)
      .set({ google_user_name: 'Current owner name' })
      .where(eq(kilocode_users.id, owner.id));
    const result = await execute();
    const stored = await effects();
    expect(result).toEqual({ invitationId: stored.invitations[0].id, emailQueued: true });
    expect(stored.invitations).toEqual([
      expect.objectContaining({
        organization_id: organization.id,
        invited_by: owner.id,
        email: input.arguments.recipient,
        role: 'member',
        accepted_at: null,
        authentication_requirement: 'default',
      }),
    ]);
    const invitation = stored.invitations[0];
    expect(Date.parse(invitation.expires_at) - Date.parse(invitation.created_at)).toBe(
      7 * 24 * 60 * 60 * 1000
    );
    expect(stored.audits).toEqual([
      expect.objectContaining({
        actor_id: owner.id,
        actor_email: owner.google_user_email,
        actor_name: 'Current owner name',
        message: `Invited ${input.arguments.recipient} as member`,
      }),
    ]);
    expect(stored.outbox).toEqual([
      expect.objectContaining({
        invitation_id: result.invitationId,
        status: 'pending',
        attempts: 0,
        payload: {
          invitationId: result.invitationId,
          to: input.arguments.recipient,
          inviterName: 'Current owner name',
          organizationName: organization.name,
          acceptInviteUrl: expect.stringContaining(invitation.token),
        },
      }),
    ]);
    expect(stored.operations).toEqual([
      expect.objectContaining({
        thread_id: threadId,
        operation_id: input.operationId,
        input_digest: authorization.harnessInputDigest(input.arguments),
        invitation_id: result.invitationId,
        canonical_result: {
          invitationId: result.invitationId,
          acceptInviteUrl: stored.outbox[0].payload.acceptInviteUrl,
          emailStatus: 'pending',
        },
      }),
    ]);
  });

  it.each(['execute', 'reconcile'] as const)(
    'serializes a racing %s behind an uncommitted invitation',
    async mode => {
      const { firstResult, secondResult } = await race(
        execute,
        mode === 'execute' ? execute : reconcile
      );
      expect(secondResult).toEqual({ status: 'fulfilled', value: firstResult });
      const stored = await effects();
      for (const rows of Object.values(stored)) expect(rows).toHaveLength(1);
    },
    15_000
  );

  it.each(['recipient', 'role'] as const)(
    'rejects a racing changed %s for one operation identity',
    async field => {
      const changed = {
        ...input,
        arguments: {
          ...input.arguments,
          ...(field === 'recipient'
            ? { recipient: 'changed@example.com' }
            : { role: 'admin' as const }),
        },
      };
      const changedToken = await mint(changed);
      const { secondResult } = await race(execute, () =>
        adapter.executeHarnessInvitation(changedToken, changed)
      );
      expect(secondResult).toMatchObject({
        status: 'rejected',
        reason: { code: 'CONFLICT', message: 'This invitation operation has different input' },
      });
      const stored = await effects();
      for (const rows of Object.values(stored)) expect(rows).toHaveLength(1);
      expect(stored.invitations[0]).toMatchObject({
        email: input.arguments.recipient,
        role: 'member',
      });
    },
    15_000
  );

  it('replays normalized IDs and reordered arguments without changing the canonical records', async () => {
    const result = await execute();
    const stored = await effects();
    const reordered = {
      operationId: input.operationId.toUpperCase(),
      arguments: { role: input.arguments.role, recipient: input.arguments.recipient },
      conversationId: threadId.toUpperCase(),
    };
    expect(await adapter.executeHarnessInvitation(token, reordered)).toEqual(result);
    expect(await effects()).toEqual(stored);
  });
  it('does not let a caller mutate the recipient while authorization waits', async () => {
    const request = structuredClone(input);
    const pending = adapter.executeHarnessInvitation(token, request);
    request.arguments.recipient = 'retargeted@example.com';
    await pending;
    expect((await effects()).invitations).toEqual([
      expect.objectContaining({ email: input.arguments.recipient }),
    ]);
  });
  it('reconciles a lost response from the recorded operation without another effect', async () => {
    await expect(
      execute().then(() => {
        throw new Error('Response lost after commit');
      })
    ).rejects.toThrow('Response lost after commit');
    const stored = await effects();
    expect(await reconcile()).toEqual({
      invitationId: stored.invitations[0].id,
      emailQueued: true,
    });
    expect(await execute()).toEqual(await reconcile());
    expect(await effects()).toEqual(stored);
  });
  it('returns absence from reconciliation without creating an invitation', async () => {
    expect(await reconcile()).toBeNull();
    await expectNoEffects();
  });
  it.each(['expired', 'accepted', 'revoked', 'deleted'] as const)(
    'retains replay permanently after the invitation is %s',
    async state => {
      const result = await execute();
      await db
        .update(agent_harness_invitation_results)
        .set({ created_at: '2000-01-01 00:00:00+00' })
        .where(eq(agent_harness_invitation_results.thread_id, threadId));
      if (state === 'deleted') {
        await db
          .delete(organization_invitations)
          .where(eq(organization_invitations.id, result.invitationId));
      } else {
        await db
          .update(organization_invitations)
          .set(
            state === 'accepted'
              ? { accepted_at: sql`clock_timestamp()` }
              : { expires_at: sql`clock_timestamp() - interval '1 day'` }
          )
          .where(eq(organization_invitations.id, result.invitationId));
        await db
          .update(external_side_effect_outbox)
          .set({ status: state === 'revoked' ? 'failed' : 'delivered' })
          .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));
      }
      const stored = await effects();
      expect(await execute()).toEqual(result);
      expect(await reconcile()).toEqual(result);
      expect(await effects()).toEqual(stored);
    }
  );
  it('returns the committed result after billing expires instead of attempting a new invitation', async () => {
    const result = await execute();
    await db
      .update(organizations)
      .set({ free_trial_end_at: '2000-01-01 00:00:00+00' })
      .where(eq(organizations.id, organization.id));
    const stored = await effects();
    expect(await execute()).toEqual(result);
    expect(await effects()).toEqual(stored);
  });

  it('rolls back invitation, audit, queue, and identity when enqueue fails after its insert', async () => {
    enqueue.mockImplementationOnce(async (tx, queued) => {
      await realEnqueue(tx, queued);
      throw new Error('Queue failure after insert');
    });
    await expect(execute()).rejects.toThrow('Queue failure after insert');
    await expectNoEffects();
    expect(await reconcile()).toBeNull();
    await expectNoEffects();
    await execute();
    for (const rows of Object.values(await effects())) expect(rows).toHaveLength(1);
  });
  it('rolls back every effect when the permanent result cannot be inserted', async () => {
    enqueue.mockImplementationOnce(async (tx, queued) => {
      const row = await realEnqueue(tx, queued);
      // Inject a real uniqueness failure at the final ledger insert, after all other writes.
      await tx.insert(agent_harness_invitation_results).values({
        thread_id: threadId,
        operation_id: input.operationId,
        input_digest: 'injected-conflict',
        invitation_id: queued.invitationId,
        canonical_result: {
          invitationId: queued.invitationId,
          acceptInviteUrl: queued.payload.acceptInviteUrl,
          emailStatus: 'pending',
        },
      });
      return row;
    });
    await expect(execute()).rejects.toThrow();
    await expectNoEffects();
    expect(await reconcile()).toBeNull();
  });
  it('preserves the pending-invitation conflict for a different operation identity', async () => {
    await execute();
    const stored = await effects();
    const different = { ...input, operationId: crypto.randomUUID() };
    await expect(
      adapter.executeHarnessInvitation(await mint(different), different)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This email already has a pending invitation',
    });
    expect(await effects()).toEqual(stored);
  });

  it('rechecks a revoked billing role after the capability was created', async () => {
    await changeRole('member');
    await expect(execute()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });
    await expectNoEffects();
  });
  it.each(['revocation', 'invitation'] as const)(
    'orders a role revocation when %s commits first',
    async first => {
      const revoke = () =>
        db.transaction(async tx => {
          await tx
            .update(organization_memberships)
            .set({ role: 'member' })
            .where(
              and(
                eq(organization_memberships.organization_id, organization.id),
                eq(organization_memberships.kilo_user_id, owner.id)
              )
            );
        });
      if (first === 'revocation') {
        const { secondResult } = await race(revoke, execute);
        expect(secondResult).toMatchObject({
          status: 'rejected',
          reason: { code: 'UNAUTHORIZED' },
        });
        await expectNoEffects();
      } else {
        const { firstResult, secondResult } = await race(execute, revoke);
        expect(secondResult.status).toBe('fulfilled');
        expect((await effects()).invitations).toEqual([
          expect.objectContaining({ id: firstResult.invitationId }),
        ]);
      }
    },
    15_000
  );
  it('checks grant expiry after waiting for its row lock', async () => {
    const expires = Date.now() + 30_000;
    await db
      .update(agent_harness_conversation_grants)
      .set({ expires_at: new Date(expires).toISOString() })
      .where(eq(agent_harness_conversation_grants.id, grantId));
    token = await mint();
    const holdGrant = () =>
      db.transaction(async tx => {
        await tx
          .select()
          .from(agent_harness_conversation_grants)
          .where(eq(agent_harness_conversation_grants.id, grantId))
          .for('update');
      });
    const { secondResult } = await race(holdGrant, execute, () => {
      jest.spyOn(Date, 'now').mockReturnValue(expires + 1);
    });
    expect(secondResult).toMatchObject({ status: 'rejected', reason: { code: 'FORBIDDEN' } });
    await expectNoEffects();
  }, 15_000);
  it.each(['revoked grant', 'blocked account', 'removed staff elevation'] as const)(
    'rechecks a %s changed after capability authorization',
    async state => {
      if (state === 'removed staff elevation') {
        await db
          .update(kilocode_users)
          .set({ is_admin: true })
          .where(eq(kilocode_users.id, owner.id));
        await db
          .delete(organization_memberships)
          .where(eq(organization_memberships.kilo_user_id, owner.id));
        token = await mint();
      }
      const transaction = db.transaction.bind(db);
      jest.spyOn(db, 'transaction').mockImplementationOnce(async work => {
        if (state === 'revoked grant')
          await db
            .update(agent_harness_conversation_grants)
            .set({ revoked_at: sql`clock_timestamp()` })
            .where(eq(agent_harness_conversation_grants.id, grantId));
        else
          await db
            .update(kilocode_users)
            .set(state === 'blocked account' ? { blocked_reason: 'blocked' } : { is_admin: false })
            .where(eq(kilocode_users.id, owner.id));
        return transaction(work);
      });
      await expect(execute()).rejects.toMatchObject({
        code: state === 'removed staff elevation' ? 'UNAUTHORIZED' : 'FORBIDDEN',
      });
      await expectNoEffects();
    }
  );
  it('does not disclose a recorded result after membership removal', async () => {
    await execute();
    const stored = await effects();
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, owner.id));
    await expect(reconcile()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(execute()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await effects()).toEqual(stored);
  });
  it('allows accepted backend work after client sign-out and session rotation', async () => {
    await db
      .update(agent_harness_clients)
      .set({ revoked_at: sql`clock_timestamp()` })
      .where(eq(agent_harness_clients.id, clientId));
    await db
      .update(kilocode_users)
      .set({ api_token_pepper: crypto.randomUUID(), web_session_pepper: crypto.randomUUID() })
      .where(eq(kilocode_users.id, owner.id));
    const result = await execute();
    expect((await effects()).invitations).toEqual([
      expect.objectContaining({ id: result.invitationId, invited_by: owner.id }),
    ]);
  });
  it.each(['membership', 'account', 'organization', 'generation', 'retirement', 'grant'] as const)(
    'blocks protected execution and reconciliation after %s authority loss',
    async state => {
      if (state === 'membership')
        await db
          .delete(organization_memberships)
          .where(eq(organization_memberships.kilo_user_id, owner.id));
      if (state === 'account')
        await db
          .update(kilocode_users)
          .set({ blocked_reason: 'blocked' })
          .where(eq(kilocode_users.id, owner.id));
      if (state === 'organization')
        await db
          .update(organizations)
          .set({ deleted_at: sql`clock_timestamp()` })
          .where(eq(organizations.id, organization.id));
      if (state === 'generation')
        await db
          .update(agent_harness_conversation_registry)
          .set({ generation: 1 })
          .where(eq(agent_harness_conversation_registry.thread_id, threadId));
      if (state === 'retirement')
        await db
          .insert(agent_harness_retirements)
          .values({ thread_id: threadId, generation: 0, reason: 'context_retired' });
      if (state === 'grant')
        await db
          .update(agent_harness_conversation_grants)
          .set({ revoked_at: sql`clock_timestamp()` })
          .where(eq(agent_harness_conversation_grants.id, grantId));
      await expect(execute()).rejects.toMatchObject({
        code: state === 'membership' ? 'UNAUTHORIZED' : 'FORBIDDEN',
      });
      await expect(reconcile()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expectNoEffects();
    }
  );
  it.each(['retirement', 'invitation'] as const)(
    'orders context retirement when %s commits first',
    async first => {
      const retire = () =>
        db.transaction(tx =>
          retirement.retireHarnessConversations(tx, { organizationId: organization.id })
        );
      if (first === 'retirement') {
        const { secondResult } = await race(retire, execute);
        expect(secondResult).toMatchObject({ status: 'rejected', reason: { code: 'FORBIDDEN' } });
        await expectNoEffects();
      } else {
        const { firstResult, secondResult } = await race(execute, retire);
        expect(secondResult.status).toBe('fulfilled');
        const stored = await effects();
        expect(stored.invitations).toEqual([
          expect.objectContaining({ id: firstResult.invitationId }),
        ]);
        expect(stored.audits).toHaveLength(1);
        expect(stored.outbox).toHaveLength(1);
        expect(stored.operations).toEqual([]);
      }
      await expect(reconcile()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    },
    15_000
  );
  it.each(['recipient', 'role', 'operation', 'conversation'] as const)(
    'rejects a changed %s under the original capability',
    async field => {
      const changed = structuredClone(input);
      if (field === 'recipient') changed.arguments.recipient = 'other@example.com';
      if (field === 'role') changed.arguments.role = 'owner';
      if (field === 'operation') changed.operationId = crypto.randomUUID();
      if (field === 'conversation') changed.conversationId = crypto.randomUUID();
      await expect(adapter.executeHarnessInvitation(token, changed)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expectNoEffects();
    }
  );
  it.each(['admin', 'billing_manager'] as const)(
    'preserves the %s owner-invitation restriction',
    async role => {
      await changeRole(role);
      input.arguments.role = 'owner';
      token = await mint();
      await expect(execute()).rejects.toMatchObject(
        role === 'admin'
          ? { code: 'FORBIDDEN', message: 'Only an organization owner can manage owners' }
          : {
              code: 'UNAUTHORIZED',
              message: 'You do not have the required organizational role to access this feature',
            }
      );
      await expectNoEffects();
    }
  );
  it('retains the billing trial precondition at execution', async () => {
    await db
      .update(organizations)
      .set({ free_trial_end_at: '2000-01-01 00:00:00+00' })
      .where(eq(organizations.id, organization.id));
    await expect(execute()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Organization trial has expired.',
    });
    await expectNoEffects();
  });
  it.each(['invalid', 'required'] as const)('preserves the %s SSO precondition', async policy => {
    const domain = `${crypto.randomUUID()}.example.com`;
    await db
      .update(organizations)
      .set({ sso_domain: policy === 'invalid' ? 'invalid domain' : domain })
      .where(eq(organizations.id, organization.id));
    input.arguments.recipient = `invited@${domain}`;
    token = await mint();
    await expect(execute()).rejects.toMatchObject(
      policy === 'invalid'
        ? {
            code: 'PRECONDITION_FAILED',
            message: 'This organization has an invalid SSO configuration',
          }
        : {
            code: 'FORBIDDEN',
            message: 'This user must join through your organization SSO provider',
          }
    );
    await expectNoEffects();
  });
  it('rejects a mismatched stored result rather than replaying or replacing it', async () => {
    await execute();
    await db
      .update(agent_harness_invitation_results)
      .set({ invitation_id: crypto.randomUUID() })
      .where(eq(agent_harness_invitation_results.thread_id, threadId));
    const stored = await effects();
    await expect(reconcile()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Invalid recorded invitation result',
    });
    await expect(execute()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(await effects()).toEqual(stored);
  });
});

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
import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@kilocode/db/client';
import {
  createQuickChatRuntime,
  QuickChatAuthorityError,
  type QuickChatAuthority,
} from '@kilocode/db/quick-chat-runtime';
import {
  agent_harness_clients as clients,
  agent_harness_conversation_grants as grants,
  agent_harness_conversation_registry as registry,
  agent_harness_retirements as retirements,
  kilocode_users,
  organizations,
  organization_memberships,
  quick_chat_threads as threads,
  quick_chat_messages as messages,
} from '@kilocode/db/schema';
import { createSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete-reasons';
import {
  createHarnessRetirementStore,
  drainHarnessRetirements,
  retireHarnessConversations,
  sendHarnessMaintenance,
  type HarnessMaintenanceRequest,
} from './retirement';
import type * as TrpcModule from '@trpc/server';
import type * as DrizzleModule from 'drizzle-orm';
import type * as CleanupRoute from '@/app/api/cron/agent-harness-cleanup/route';
import type * as AuthorizationModule from './authorization';
import type { HarnessCapabilityScope } from './authorization';
import type * as OrganizationAdminModule from '@/routers/organizations/organization-admin-router';
import { KILO_PASS_ORG_HIERARCHY_ALLOCATION_ERROR } from '@/lib/kilo-pass-org/hierarchy-guard';
import {
  kilo_pass_org_agreements,
  kilo_pass_org_allocation_plans,
  kilo_pass_org_allocation_plan_rows,
  kilo_pass_org_term_versions,
} from '@kilocode/db/schema';
import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import { KiloPassOrgBonusMode } from '@kilocode/db/schema-types';

let database: DrizzleClient | undefined;
let cronDatabaseAllowed = false;
const emptyPrimary = {
  query: { organizations: { findFirst: async () => undefined } },
  execute: async () => {
    if (!cronDatabaseAllowed) throw new Error('Unauthorized cron accessed the database');
    return { rows: [] };
  },
  transaction: async (work: (tx: unknown) => Promise<unknown>) => work(emptyPrimary),
};
jest.mock('@/lib/drizzle', () => {
  const { sql } = jest.requireActual<typeof DrizzleModule>('drizzle-orm');
  return {
    sql,
    auto_deleted_at: { deleted_at: sql`now()` },
    get db() {
      return database?.db ?? emptyPrimary;
    },
  };
});
jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'test-cron',
  NEXTAUTH_SECRET: 'test-signing',
  INTERNAL_API_SECRET: 'test-service',
}));
jest.mock('@/lib/constants', () => ({ APP_URL: 'https://web.example', TRIAL_DURATION_DAYS: 14 }));
jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/trpc/init', () => {
  const trpc = jest.requireActual<typeof TrpcModule>('@trpc/server').initTRPC.create();
  return {
    baseProcedure: trpc.procedure,
    adminProcedure: trpc.procedure,
    creditManagerProcedure: trpc.procedure,
    createTRPCRouter: trpc.router,
  };
});
// Keep the real deletion router, hierarchy guard, retirement, and organization SQL.
// Unrelated services do not participate in these transaction tests.
jest.mock('@/lib/organizations/organization-billing', () => ({}));
jest.mock('@/lib/organizations/organization-seats', () => ({
  getMostRecentSeatPurchase: async () => null,
}));
jest.mock('@/lib/organizations/organization-sso-policy', () => ({}));
jest.mock('@/lib/organizations/organization-audit-logs', () => ({}));
jest.mock('@/lib/organizations/organization-member-analytics', () => ({}));
jest.mock('@/lib/organizations/organization-groups', () => ({}));
jest.mock('@/lib/user', () => ({}));
jest.mock('@/lib/ai-gateway/abuse-service', () => ({}));
jest.mock('@/lib/creditTransactions', () => ({}));
jest.mock('@/lib/creditExpiration', () => ({}));
jest.mock('@/lib/kilo-pass-org/service', () => ({}));
jest.mock('@/lib/session-ingest-client', () => ({}));
jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({}));
jest.mock('@/lib/organizations/trial-middleware', () => ({
  requireActiveSubscriptionOrTrial: jest.fn(),
}));
jest.mock('@/lib/admin/admin-access-log', () => ({
  elevateViaKiloAdmin: async (_ctx: unknown, input: { grant: string }) => input.grant,
  organizationTarget: (id: string) => id,
}));

type Purge = Extract<HarnessMaintenanceRequest, { type: 'purge' }>;
const request: Purge = { type: 'purge', protocolVersion: 1, threadId: randomUUID(), generation: 3 };
const receipt = (input: Pick<Purge, 'threadId' | 'generation'>) => ({
  threadId: input.threadId,
  generation: input.generation,
  durable: true as const,
});
function memorySource() {
  let pending = true;
  const claim = { ...receipt(request), leaseToken: randomUUID() };
  return {
    pending: () => pending,
    claim: async () => (pending ? [claim] : []),
    acknowledge: async () => {
      pending = false;
      return true;
    },
  };
}

function organizationAdminCaller() {
  const { organizationAdminRouter } = jest.requireActual<typeof OrganizationAdminModule>(
    '@/routers/organizations/organization-admin-router'
  );
  return organizationAdminRouter.createCaller(
    {} as Parameters<typeof organizationAdminRouter.createCaller>[0]
  );
}

describe('retirement pure', () => {
  it('retains the missing-organization response before starting retirement', async () => {
    await expect(
      organizationAdminCaller().delete({ organizationId: randomUUID() })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Organization not found',
    });
  });

  it('keeps cleanup pending until the durable purge receipt arrives', async () => {
    const source = memorySource();
    const started = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<ReturnType<typeof receipt>>();
    const draining = drainHarnessRetirements(source, async () => {
      started.resolve();
      return committed.promise;
    });
    await started.promise;
    expect(source.pending()).toBe(true);
    committed.resolve(receipt(request));
    expect(await draining).toEqual({ acknowledged: 1, retry: 0 });
    expect(source.pending()).toBe(false);
  });

  it('retries a rejected lease acknowledgment even after a valid purge receipt', async () => {
    const source = memorySource();
    expect(
      await drainHarnessRetirements({ ...source, acknowledge: async () => false }, async input =>
        receipt(input)
      )
    ).toEqual({ acknowledged: 0, retry: 1 });
    expect(source.pending()).toBe(true);
    expect(await drainHarnessRetirements(source, async input => receipt(input))).toEqual({
      acknowledged: 1,
      retry: 0,
    });
    expect(source.pending()).toBe(false);
  });

  it('keeps a lost purge acknowledgment pending and safely repeats the same retirement', async () => {
    const source = memorySource();
    const other = randomUUID();
    const payloads = new Map([
      [request.threadId, 'deleted history'],
      [other, 'other account'],
    ]);
    const purge = async (input: Purge) => {
      payloads.delete(input.threadId);
      return receipt(input);
    };
    expect(
      await drainHarnessRetirements(source, async input => {
        await purge(input);
        throw new Error('Worker response lost');
      })
    ).toEqual({ acknowledged: 0, retry: 1 });
    expect(source.pending()).toBe(true);
    expect(await drainHarnessRetirements(source, purge)).toEqual({ acknowledged: 1, retry: 0 });
    expect(source.pending()).toBe(false);
    expect([...payloads]).toEqual([[other, 'other account']]);
  });

  it('continues another account purge when one delivery fails', async () => {
    const first = { ...request, leaseToken: randomUUID() };
    const second = { threadId: randomUUID(), generation: 2, leaseToken: randomUUID() };
    const pending = new Map([first, second].map(claim => [claim.threadId, claim]));
    expect(
      await drainHarnessRetirements(
        {
          claim: async () => [...pending.values()],
          acknowledge: async claim => pending.delete(claim.threadId),
        },
        async input => {
          if (input.threadId === first.threadId) throw new Error('Worker unavailable');
          return receipt(input);
        }
      )
    ).toEqual({ acknowledged: 1, retry: 1 });
    expect([...pending.keys()]).toEqual([first.threadId]);
  });

  it.each([
    ['outage', () => new Response('', { status: 503 })],
    ['HTML', () => new Response('{}', { headers: { 'content-type': 'text/html' } })],
    ['missing body', () => new Response(null, { headers: { 'content-type': 'application/json' } })],
    ['invalid JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
    ['null receipt', () => Response.json(null)],
    ['oversized body', () => Response.json({ value: 'x'.repeat(4096) })],
    ['wrong thread', () => Response.json({ ...receipt(request), threadId: randomUUID() })],
    ['wrong generation', () => Response.json({ ...receipt(request), generation: 4 })],
    ['not durable', () => Response.json({ ...receipt(request), durable: false })],
    ['extra payload', () => Response.json({ ...receipt(request), content: 'private text' })],
  ])('never acknowledges %s as a purge', async (_name, response) => {
    const source = memorySource();
    expect(
      await drainHarnessRetirements(source, (input, dispatchId) =>
        sendHarnessMaintenance(
          'https://harness.example',
          'test-signing',
          'test-service',
          input,
          dispatchId,
          async () => response()
        )
      )
    ).toEqual({ acknowledged: 0, retry: 1 });
    expect(source.pending()).toBe(true);
  });

  it.each([
    undefined,
    'http://harness.example',
    'https://user:password@harness.example',
    'file:///harness',
  ])('retains cleanup for an unavailable or unsafe endpoint: %s', async endpoint => {
    const source = memorySource();
    expect(
      await drainHarnessRetirements(source, (input, dispatchId) =>
        sendHarnessMaintenance(
          endpoint,
          'test-signing',
          'test-service',
          input,
          dispatchId,
          async () => Response.json(receipt(request))
        )
      )
    ).toEqual({ acknowledged: 0, retry: 1 });
    expect(source.pending()).toBe(true);
  });

  it('delivers only a signed, short-lived, body-bound purge to the fixed maintenance route', async () => {
    const source = memorySource();
    const [claim] = await source.claim();
    const receiver: typeof fetch = async (url, init) => {
      expect(String(url)).toBe('https://harness.example/internal/maintenance');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual(request);
      const headers = new Headers(init?.headers);
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('x-internal-api-key')).toBe('test-service');
      const token = headers.get('authorization')?.slice(7) ?? '';
      const claims = jwt.verify(token, 'test-signing', {
        algorithms: ['HS256'],
        issuer: 'agent-harness',
        audience: 'agent-harness:maintenance',
      }) as jwt.JwtPayload;
      expect(claims).toMatchObject({
        operation: 'purge',
        threadId: request.threadId,
        generation: 3,
        dispatchId: claim.leaseToken,
      });
      if (claims.inputDigest !== createHash('sha256').update(String(init?.body)).digest('hex'))
        return Response.json({ error: 'Body does not match its capability' }, { status: 403 });
      expect(claims).not.toHaveProperty('userId');
      expect(() =>
        jwt.verify(token, 'test-signing', { clockTimestamp: Number(claims.iat) + 60 })
      ).toThrow();
      return Response.json(receipt(request));
    };
    expect(
      await drainHarnessRetirements(source, (input, dispatchId) =>
        sendHarnessMaintenance(
          'https://harness.example/ignored',
          'test-signing',
          'test-service',
          input,
          dispatchId,
          receiver
        )
      )
    ).toEqual({ acknowledged: 1, retry: 0 });
    expect(source.pending()).toBe(false);
  });

  it('authenticates the cron before work and returns an honest empty batch', async () => {
    const { GET } = jest.requireActual<typeof CleanupRoute>(
      '@/app/api/cron/agent-harness-cleanup/route'
    );
    cronDatabaseAllowed = false;
    const denied = await GET(new Request('https://web.example/api/cron/agent-harness-cleanup'));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'Unauthorized' });
    cronDatabaseAllowed = true;
    const response = await GET(
      new Request('https://web.example/api/cron/agent-harness-cleanup', {
        headers: { authorization: 'Bearer test-cron' },
      })
    );
    expect(await response.json()).toEqual({
      success: true,
      swept: 0,
      purge: { acknowledged: 0, retry: 0 },
      ingress: { acknowledged: 0, retry: 0, rejected: 0 },
    });
  });
});

// CI uses the normal database-backed launcher. The pure checks never load its setup or environment files.
describe('retirement PostgreSQL', () => {
  let primary: DrizzleClient['db'];
  let store: ReturnType<typeof createHarnessRetirementStore>;
  let authority: QuickChatAuthority;
  let otherUser: string;
  let organizationId: string;
  let ids: string[];
  let grantId: string;

  beforeAll(async () => {
    const { createDrizzleClient, computeDatabaseUrl } = await import('@kilocode/db');
    database = createDrizzleClient({
      connectionString: computeDatabaseUrl(),
      poolConfig: { max: 3 },
    });
    primary = database.db;
    store = createHarnessRetirementStore(primary);
  });
  beforeEach(async () => {
    authority = {
      threadId: randomUUID(),
      userId: `oauth/github:${randomUUID()}`,
      organizationId: null,
      generation: 3,
    };
    otherUser = `oauth/github:${randomUUID()}`;
    organizationId = randomUUID();
    ids = [authority.threadId, randomUUID()];
    await primary.insert(kilocode_users).values(
      [authority.userId, otherUser].map(id => ({
        id,
        google_user_email: `${randomUUID()}@example.com`,
        google_user_name: 'Retirement test',
        google_user_image_url: '',
        stripe_customer_id: `cus_${randomUUID()}`,
      }))
    );
    await primary.insert(organizations).values({ id: organizationId, name: 'Retirement test' });
    await primary
      .insert(organization_memberships)
      .values({ organization_id: organizationId, kilo_user_id: authority.userId, role: 'owner' });
    await primary
      .insert(threads)
      .values(ids.map((id, i) => ({ id, user_id: i ? otherUser : authority.userId })));
    await primary.insert(registry).values(
      ids.map((thread_id, i) => ({
        thread_id,
        user_id: i ? otherUser : authority.userId,
        generation: 3,
      }))
    );
    await primary
      .insert(messages)
      .values(ids.map(thread_id => ({ thread_id, role: 'assistant', content: 'private text' })));
    const clientId = randomUUID();
    await primary.insert(clients).values({
      id: clientId,
      user_id: authority.userId,
      kind: 'browser',
      session_binding: 'test-session',
    });
    grantId = randomUUID();
    await primary.insert(grants).values({
      id: grantId,
      thread_id: authority.threadId,
      user_id: authority.userId,
      client_id: clientId,
      generation: 3,
      expires_at: '2100-01-01T00:00:00Z',
    });
  });
  afterEach(async () => {
    await primary.delete(retirements).where(inArray(retirements.thread_id, ids));
    await primary.delete(registry).where(inArray(registry.thread_id, ids));
    await primary.delete(threads).where(inArray(threads.id, ids));
    await primary
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, organizationId));
    await primary.delete(organizations).where(eq(organizations.id, organizationId));
    await primary
      .delete(kilocode_users)
      .where(inArray(kilocode_users.id, [authority.userId, otherUser]));
  });
  afterAll(async () => {
    await database?.pool.end();
    database = undefined;
  });
  const fences = () =>
    primary.select().from(retirements).where(eq(retirements.thread_id, authority.threadId));
  const deleteOrganization = () => organizationAdminCaller().delete({ organizationId });

  async function useOrganizationAuthority() {
    authority.organizationId = organizationId;
    await primary
      .update(threads)
      .set({ organization_id: organizationId })
      .where(eq(threads.id, authority.threadId));
    await primary
      .update(registry)
      .set({ organization_id: organizationId })
      .where(eq(registry.thread_id, authority.threadId));
  }

  async function waitForBlockedTransaction(blocker: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { rows } = await primary.execute<{ blocked: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted
            AND ${blocker}::integer = ANY(pg_blocking_pids(pid))
        ) AS blocked
      `);
      if (rows[0].blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('The concurrent transaction did not reach the held row lock');
  }

  it.each([
    ['ingress', 'thread'],
    ['ingress', 'registry'],
    ['projection', 'thread'],
    ['projection', 'registry'],
    ['ingress', 'deletion'],
    ['projection', 'deletion'],
  ] as const)(
    'commits deletion overlapping %s with %s admitted first',
    async (kind, firstLock) => {
      await useOrganizationAuthority();
      const unrelatedHistory = await primary
        .select()
        .from(messages)
        .where(eq(messages.thread_id, ids[1]));
      const runtime = createQuickChatRuntime(primary);
      const [claim] = await runtime.claimPending({ authority });
      const projection = {
        id: randomUUID(),
        key: randomUUID(),
        role: 'assistant' as const,
        content: 'overlapping projection',
        createdAt: new Date().toISOString(),
      };
      const work = (source: Parameters<typeof createQuickChatRuntime>[0]) => {
        const harness = createQuickChatRuntime(source);
        return kind === 'ingress'
          ? harness.withClaim(claim, acknowledge => acknowledge())
          : harness.projectText(authority, projection);
      };
      const admitted = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const originalTransaction = primary.transaction.bind(primary);
      const transactionSpy = jest.spyOn(primary, 'transaction');
      let first: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let second: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        if (firstLock === 'deletion') {
          // Hold the real router transaction after its SQL, but before commit.
          transactionSpy.mockImplementationOnce((callback, config) =>
            originalTransaction(async tx => {
              await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
              const result = await callback(tx);
              const { rows } = await tx.execute<{ pid: number }>(
                sql`SELECT pg_backend_pid() AS pid`
              );
              admitted.resolve(rows[0].pid);
              await release.promise;
              return result;
            }, config)
          );
        }
        const firstOperation =
          firstLock === 'deletion'
            ? deleteOrganization()
            : primary.transaction(async tx => {
                await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
                const { rows } = await tx.execute<{ pid: number }>(
                  sql`SELECT pg_backend_pid() AS pid`
                );
                // Stage admission at either side of its registry lock, without sleeps.
                await tx.execute(sql`
                  SELECT thread.id FROM ${threads} AS thread
                  JOIN ${kilocode_users} AS owner ON owner.id = thread.user_id
                  JOIN ${registry} AS registry ON registry.thread_id = thread.id
                  WHERE thread.id = ${authority.threadId}
                  FOR SHARE OF thread${firstLock === 'registry' ? sql`, owner, registry` : sql``}
                `);
                admitted.resolve(rows[0].pid);
                await release.promise;
                return work(tx);
              });
        first = Promise.allSettled([firstOperation]);
        void firstOperation.catch(admitted.reject);
        const blocker = await admitted.promise;
        second = Promise.allSettled([
          firstLock === 'deletion' ? work(primary) : deleteOrganization(),
        ]);
        // Only release admission after PostgreSQL proves the other transaction is waiting.
        await waitForBlockedTransaction(blocker);
        release.resolve();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        const deletion = firstLock === 'deletion' ? firstResult : secondResult;
        const harness = firstLock === 'deletion' ? secondResult : firstResult;
        expect(deletion).toEqual([{ status: 'fulfilled', value: { success: true } }]);
        expect(harness).toEqual([
          firstLock === 'deletion'
            ? { status: 'rejected', reason: expect.any(QuickChatAuthorityError) }
            : { status: 'fulfilled', value: kind === 'ingress' ? true : projection.id },
        ]);
      } finally {
        release.resolve();
        transactionSpy.mockRestore();
        await Promise.all([first, second]);
      }
      expect(
        await primary.select().from(organizations).where(eq(organizations.id, organizationId))
      ).toEqual([expect.objectContaining({ deleted_at: expect.any(String) })]);
      expect(
        await primary.select().from(threads).where(eq(threads.id, authority.threadId))
      ).toEqual([]);
      expect(
        await primary.select().from(messages).where(eq(messages.thread_id, authority.threadId))
      ).toEqual([]);
      expect(await fences()).toEqual([
        expect.objectContaining({
          generation: 3,
          reason: 'context_retired',
          acknowledged_at: null,
        }),
      ]);
      expect(await runtime.lookupThread(authority)).toBeNull();
      await expect(runtime.claimPending({ authority })).rejects.toBeInstanceOf(
        QuickChatAuthorityError
      );
      await expect(runtime.withClaim(claim, acknowledge => acknowledge())).rejects.toBeInstanceOf(
        QuickChatAuthorityError
      );
      await expect(runtime.projectText(authority, projection)).rejects.toBeInstanceOf(
        QuickChatAuthorityError
      );
      expect(await drainHarnessRetirements(store, async input => receipt(input))).toEqual({
        acknowledged: 1,
        retry: 0,
      });
      expect(await fences()).toEqual([
        expect.objectContaining({
          generation: 3,
          reason: 'context_retired',
          acknowledged_at: expect.any(String),
        }),
      ]);
      expect(
        await primary.select().from(registry).where(eq(registry.thread_id, authority.threadId))
      ).toEqual([]);
      expect(await primary.select().from(messages).where(eq(messages.thread_id, ids[1]))).toEqual(
        unrelatedHistory
      );
    },
    15_000
  );

  it('rolls retirement back when the real hierarchy guard denies organization deletion', async () => {
    await useOrganizationAuthority();
    const parentId = randomUUID();
    const termId = randomUUID();
    const agreementId = randomUUID();
    const planId = randomUUID();
    const history = await primary
      .select()
      .from(messages)
      .where(eq(messages.thread_id, authority.threadId));
    try {
      await primary.insert(organizations).values({ id: parentId, name: 'Allocated parent' });
      await primary
        .update(organizations)
        .set({ parent_organization_id: parentId })
        .where(eq(organizations.id, organizationId));
      await primary.insert(kilo_pass_org_term_versions).values({
        id: termId,
        version_key: randomUUID(),
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        billing_price_microdollars_per_pass: 1,
        base_credit_microdollars_per_pass: 1,
        bonus_credit_microdollars_per_pass: 0,
        unlock_spend_microdollars_per_pass: 0,
        bonus_mode: KiloPassOrgBonusMode.AfterBase,
      });
      await primary.insert(kilo_pass_org_agreements).values({
        id: agreementId,
        parent_organization_id: parentId,
        term_version_id: termId,
        state: 'active',
        processing_condition: 'ready',
        purchase_channel: 'manual',
        cadence: KiloPassCadence.Monthly,
        purchased_pass_capacity: 1,
        issuance_anchor_at: new Date().toISOString(),
      });
      await primary.insert(kilo_pass_org_allocation_plans).values({
        id: planId,
        agreement_id: agreementId,
        effective_window_start: '2000-01-01T00:00:00Z',
        version: 1,
        created_by_kilo_user_id: authority.userId,
      });
      await primary.insert(kilo_pass_org_allocation_plan_rows).values({
        allocation_plan_id: planId,
        allocation_container_organization_id: organizationId,
        pass_capacity: 1,
      });
      await expect(deleteOrganization()).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: KILO_PASS_ORG_HIERARCHY_ALLOCATION_ERROR,
      });
      expect(await fences()).toEqual([]);
      expect(await createQuickChatRuntime(primary).lookupThread(authority)).toEqual(authority);
      expect(
        await primary.select().from(messages).where(eq(messages.thread_id, authority.threadId))
      ).toEqual(history);
      expect(await primary.select().from(grants).where(eq(grants.id, grantId))).toHaveLength(1);
      expect(
        await primary.select().from(organizations).where(eq(organizations.id, organizationId))
      ).toEqual([expect.objectContaining({ deleted_at: null })]);
    } finally {
      await primary
        .delete(kilo_pass_org_agreements)
        .where(eq(kilo_pass_org_agreements.id, agreementId));
      await primary
        .delete(kilo_pass_org_term_versions)
        .where(eq(kilo_pass_org_term_versions.id, termId));
      await primary
        .update(organizations)
        .set({ parent_organization_id: null })
        .where(eq(organizations.id, organizationId));
      await primary.delete(organizations).where(eq(organizations.id, parentId));
    }
  });

  it.each([
    'missing thread',
    'mismatched owner',
    'mismatched context',
    'deleted account',
    'missing account',
    'retired organization',
    'missing organization',
  ])('denies late reads, dispatch, import, and projection before sweeping a %s', async loss => {
    if (loss === 'retired organization' || loss === 'missing organization') {
      authority.organizationId = organizationId;
      await primary
        .update(threads)
        .set({ organization_id: organizationId })
        .where(eq(threads.id, authority.threadId));
      await primary
        .update(registry)
        .set({ organization_id: organizationId })
        .where(eq(registry.thread_id, authority.threadId));
    }
    const runtime = createQuickChatRuntime(primary);
    const [claim] = await runtime.claimPending({ authority });
    const { mintHarnessCapability, authorizeHarnessCapability } =
      jest.requireActual<typeof AuthorizationModule>('./authorization');
    const scope: HarnessCapabilityScope = {
      audience: 'agent-harness:operations',
      conversationId: authority.threadId,
      operation: 'kilo.members',
      definitionVersion: '1',
      inputDigest: '0'.repeat(64),
      dispatchId: randomUUID(),
      target: { kind: 'backend' },
    };
    const token = await mintHarnessCapability(grantId, scope);
    if (loss === 'missing thread' || loss === 'missing account')
      await primary.delete(threads).where(eq(threads.id, authority.threadId));
    if (loss === 'missing account')
      await primary.delete(kilocode_users).where(eq(kilocode_users.id, authority.userId));
    if (loss === 'mismatched owner')
      await primary
        .update(registry)
        .set({ user_id: otherUser })
        .where(eq(registry.thread_id, authority.threadId));
    if (loss === 'mismatched context')
      await primary
        .update(registry)
        .set({ organization_id: organizationId })
        .where(eq(registry.thread_id, authority.threadId));
    if (loss === 'deleted account')
      await primary
        .update(kilocode_users)
        .set({ blocked_reason: createSoftDeletedBlockedReason() })
        .where(eq(kilocode_users.id, authority.userId));
    if (loss === 'retired organization')
      await primary
        .update(organizations)
        .set({ deleted_at: sql`now()` })
        .where(eq(organizations.id, organizationId));
    if (loss === 'missing organization')
      await primary.delete(organizations).where(eq(organizations.id, organizationId));
    expect(await fences()).toEqual([]);
    expect(await runtime.lookupThread(authority)).toBeNull();
    await expect(authorizeHarnessCapability(token, scope)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(runtime.claimPending({ authority })).rejects.toBeInstanceOf(
      QuickChatAuthorityError
    );
    await expect(runtime.withClaim(claim, acknowledge => acknowledge())).rejects.toBeInstanceOf(
      QuickChatAuthorityError
    );
    const projection = {
      id: randomUUID(),
      key: randomUUID(),
      role: 'assistant' as const,
      content: 'late text',
      createdAt: new Date().toISOString(),
    };
    await expect(runtime.projectText(authority, projection)).rejects.toBeInstanceOf(
      QuickChatAuthorityError
    );
    expect(await primary.select().from(messages).where(eq(messages.id, projection.id))).toEqual([]);
    expect(await store.sweep()).toBe(1);
    expect(await store.sweep()).toBe(0);
    expect(await drainHarnessRetirements(store, async input => receipt(input))).toEqual({
      acknowledged: 1,
      retry: 0,
    });
    expect(await fences()).toEqual([
      expect.objectContaining({
        generation: 3,
        acknowledged_at: expect.any(String),
        lease_token: null,
      }),
    ]);
    expect(
      await primary.select().from(registry).where(eq(registry.thread_id, authority.threadId))
    ).toEqual([]);
    expect(await primary.select().from(threads).where(eq(threads.id, authority.threadId))).toEqual(
      []
    );
    expect(
      await primary.select().from(messages).where(eq(messages.thread_id, authority.threadId))
    ).toEqual([]);
    await expect(runtime.projectText(authority, projection)).rejects.toBeInstanceOf(
      QuickChatAuthorityError
    );
    expect(await primary.select().from(messages).where(eq(messages.thread_id, ids[1]))).toEqual([
      expect.objectContaining({ content: 'private text' }),
    ]);
  });

  it('scrubs an old-server installation without a coordinator but retains an ordinary blocked account', async () => {
    await primary.delete(threads).where(eq(threads.id, authority.threadId));
    await primary.delete(registry).where(eq(registry.thread_id, authority.threadId));
    await primary
      .update(kilocode_users)
      .set({ blocked_reason: createSoftDeletedBlockedReason() })
      .where(eq(kilocode_users.id, authority.userId));
    await primary
      .update(kilocode_users)
      .set({ blocked_reason: 'manual abuse block' })
      .where(eq(kilocode_users.id, otherUser));
    await primary
      .insert(clients)
      .values({ user_id: otherUser, kind: 'browser', session_binding: 'retain this installation' });
    expect(await store.sweep()).toBe(0);
    expect(
      await primary
        .select()
        .from(clients)
        .where(inArray(clients.user_id, [authority.userId, otherUser]))
    ).toEqual([
      expect.objectContaining({ user_id: otherUser, session_binding: 'retain this installation' }),
    ]);
    expect(
      await primary.select().from(messages).where(eq(messages.thread_id, ids[1]))
    ).toHaveLength(1);
  });

  it('rolls organization retirement back with its caller and preserves unrelated personal history', async () => {
    const orphanId = randomUUID();
    ids.push(orphanId);
    await primary.insert(registry).values({
      thread_id: orphanId,
      user_id: otherUser,
      organization_id: organizationId,
      generation: 5,
    });
    // The thread selector must also cover its stale registry context.
    await primary
      .update(threads)
      .set({ organization_id: organizationId })
      .where(eq(threads.id, authority.threadId));
    await expect(
      primary.transaction(async tx => {
        await retireHarnessConversations(tx, { organizationId });
        throw new Error('Rollback');
      })
    ).rejects.toThrow('Rollback');
    expect(
      await primary.select().from(retirements).where(inArray(retirements.thread_id, ids))
    ).toEqual([]);
    expect(
      await primary.select().from(messages).where(eq(messages.thread_id, authority.threadId))
    ).toHaveLength(1);
    expect(await primary.select().from(registry).where(eq(registry.thread_id, orphanId))).toEqual([
      expect.objectContaining({ user_id: otherUser, organization_id: organizationId }),
    ]);
    await primary.transaction(tx => retireHarnessConversations(tx, { organizationId }));
    expect(await fences()).toEqual([
      expect.objectContaining({ generation: 3, reason: 'context_retired', acknowledged_at: null }),
    ]);
    expect(
      await primary.select().from(retirements).where(eq(retirements.thread_id, orphanId))
    ).toEqual([
      expect.objectContaining({ generation: 5, reason: 'context_retired', acknowledged_at: null }),
    ]);
    expect(
      await primary
        .select()
        .from(registry)
        .where(inArray(registry.thread_id, [authority.threadId, orphanId]))
    ).toEqual([
      expect.objectContaining({ user_id: null, organization_id: null }),
      expect.objectContaining({ user_id: null, organization_id: null }),
    ]);
    expect(
      await primary.select().from(messages).where(eq(messages.thread_id, authority.threadId))
    ).toEqual([]);
    expect(
      await primary.select().from(grants).where(eq(grants.thread_id, authority.threadId))
    ).toEqual([]);
    expect(
      await primary.select().from(messages).where(eq(messages.thread_id, ids[1]))
    ).toHaveLength(1);
  });

  it('drains purge and registered ingress through the cron after a Worker outage', async () => {
    const unregisteredId = randomUUID();
    ids.push(unregisteredId);
    await primary.insert(threads).values({
      id: unregisteredId,
      user_id: otherUser,
      organization_id: organizationId,
    });
    await primary.insert(messages).values({
      thread_id: unregisteredId,
      role: 'user',
      content: 'unregistered history',
    });
    await primary.transaction(async tx => {
      await retireHarnessConversations(tx, { userId: authority.userId });
      await tx
        .update(kilocode_users)
        .set({ blocked_reason: createSoftDeletedBlockedReason() })
        .where(eq(kilocode_users.id, authority.userId));
    });
    const { GET } = jest.requireActual<typeof CleanupRoute>(
      '@/app/api/cron/agent-harness-cleanup/route'
    );
    const runCron = () =>
      GET(
        new Request('https://web.example/api/cron/agent-harness-cleanup', {
          headers: { authorization: 'Bearer test-cron' },
        })
      );
    const previousEndpoint = process.env.AGENT_HARNESS_API_URL;
    process.env.AGENT_HARNESS_API_URL = 'https://harness.example';
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    try {
      fetchMock.mockImplementation(async () => new Response('', { status: 503 }));
      expect(await (await runCron()).json()).toEqual({
        success: true,
        swept: 0,
        purge: { acknowledged: 0, retry: 1 },
        ingress: { acknowledged: 0, retry: 1, rejected: 0 },
      });
      expect(
        await primary.select().from(threads).where(eq(threads.id, authority.threadId))
      ).toEqual([]);
      expect(await fences()).toEqual([expect.objectContaining({ acknowledged_at: null })]);
      expect(await primary.select().from(messages).where(eq(messages.thread_id, ids[1]))).toEqual([
        expect.objectContaining({ content: 'private text', ingress_acknowledged_at: null }),
      ]);
      await primary
        .update(retirements)
        .set({ lease_expires_at: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(retirements.thread_id, authority.threadId));
      await primary
        .update(messages)
        .set({ ingress_lease_expires_at: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(messages.thread_id, ids[1]));

      // The injected receiver proves cron/adapter ordering, not Worker SQLite durability.
      const imported = new Map<string, string>();
      fetchMock.mockImplementation(async (_url, init) => {
        const input = JSON.parse(String(init?.body)) as HarnessMaintenanceRequest;
        if (input.type === 'purge') return Response.json(receipt(input));
        const headers = new Headers(init?.headers);
        const token = headers.get('authorization')?.slice(7) ?? '';
        expect(
          jwt.verify(token, 'test-signing', {
            algorithms: ['HS256'],
            issuer: 'agent-harness',
            audience: 'agent-harness:maintenance',
          })
        ).toMatchObject({
          operation: 'importLegacy',
          threadId: ids[1],
          userId: otherUser,
          organizationId: null,
          generation: 3,
          dispatchId: input.message.id,
          inputDigest: createHash('sha256').update(String(init?.body)).digest('hex'),
        });
        expect(input.protocolVersion).toBe(1);
        expect(input.message.provenance).toBe('legacy');
        imported.set(input.message.id, input.message.content);
        return Response.json({ ...input.authority, messageId: input.message.id, durable: true });
      });
      expect(await (await runCron()).json()).toEqual({
        success: true,
        swept: 0,
        purge: { acknowledged: 1, retry: 0 },
        ingress: { acknowledged: 1, retry: 0, rejected: 0 },
      });
      expect(await fences()).toEqual([
        expect.objectContaining({ acknowledged_at: expect.any(String) }),
      ]);
      expect(
        await primary.select().from(registry).where(eq(registry.thread_id, authority.threadId))
      ).toEqual([]);
      expect(await primary.select().from(messages).where(eq(messages.thread_id, ids[1]))).toEqual([
        expect.objectContaining({
          ingress_acknowledged_at: expect.any(String),
          ingress_lease_token: null,
        }),
      ]);
      expect(
        await primary.select().from(messages).where(eq(messages.thread_id, unregisteredId))
      ).toEqual([
        expect.objectContaining({
          content: 'unregistered history',
          ingress_acknowledged_at: null,
          ingress_lease_token: null,
        }),
      ]);
      expect(await (await runCron()).json()).toEqual({
        success: true,
        swept: 0,
        purge: { acknowledged: 0, retry: 0 },
        ingress: { acknowledged: 0, retry: 0, rejected: 0 },
      });
      expect([...imported.values()]).toEqual(['private text']);
    } finally {
      fetchMock.mockRestore();
      if (previousEndpoint === undefined) delete process.env.AGENT_HARNESS_API_URL;
      else process.env.AGENT_HARNESS_API_URL = previousEndpoint;
    }
  });

  it('leases disjoint bounded batches and rejects stale acknowledgment without erasing permanent fences', async () => {
    const orphanIds = Array.from({ length: 3 }, () => randomUUID());
    ids.push(...orphanIds);
    await primary.insert(registry).values(orphanIds.map(thread_id => ({ thread_id })));
    expect(await store.sweep(2)).toBe(2);
    const [a, b] = await Promise.all([store.claim(1), store.claim(1)]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(new Set([...a, ...b].map(row => row.threadId)).size).toBe(2);
    expect(await store.claim()).toEqual([]);
    const old = a[0];
    await primary
      .update(retirements)
      .set({ lease_expires_at: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(retirements.thread_id, old.threadId));
    expect(await store.acknowledge(old)).toBe(false);
    const [current] = await store.claim(1);
    expect(await store.acknowledge(old)).toBe(false);
    expect(await store.acknowledge({ ...current, leaseToken: b[0].leaseToken })).toBe(false);
    expect(await store.acknowledge(current)).toBe(true);
    expect(await store.acknowledge(current)).toBe(false);
    expect(
      await primary.select().from(retirements).where(eq(retirements.thread_id, b[0].threadId))
    ).toEqual([expect.objectContaining({ acknowledged_at: null, lease_token: b[0].leaseToken })]);
    expect(
      await primary.select().from(retirements).where(eq(retirements.thread_id, old.threadId))
    ).toEqual([
      expect.objectContaining({ acknowledged_at: expect.any(String), lease_token: null }),
    ]);
    expect(await store.sweep()).toBe(1);
  });
});

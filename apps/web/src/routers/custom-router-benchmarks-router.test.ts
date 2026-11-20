import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  customRouterEntryKey,
  type CustomRouterEntry,
  type PaidBenchmarkProgress,
  type PaidBenchmarkQuote,
} from '@kilocode/auto-routing-contracts';
import {
  auto_routing_custom_routers,
  organization_memberships,
  type User,
} from '@kilocode/db/schema';
import {
  getCustomRouterTable,
  getPaidBenchmarkProgress,
  lookupCustomRouterBlockedModels,
  pausePaidBenchmark,
  requestPaidBenchmarkQuote,
  startPaidBenchmark,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq, sql } from 'drizzle-orm';
import { createCallerFactory, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { customRouterBenchmarksRouter } from './custom-router-benchmarks-router';
import { lockOwner } from '@/lib/auto-routing-custom-routers';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  getCustomRouterStatus: jest.fn(),
  getCustomRouterTable: jest.fn(),
  getPaidBenchmarkProgress: jest.fn(),
  getPlatformMeasurements: jest.fn(),
  lookupCustomRouterBlockedModels: jest.fn(),
  pausePaidBenchmark: jest.fn(),
  pausePoolBenchmark: jest.fn(),
  requestPaidBenchmarkQuote: jest.fn(),
  startPaidBenchmark: jest.fn(),
}));

const createCaller = createCallerFactory(
  createTRPCRouter({ customRouterBenchmarks: customRouterBenchmarksRouter })
);

/**
 * A signed-in browser caller: the context the request boundary builds for a session cookie. The
 * tests pre-exercise the cookie path, so the credential is the boundary's own classification for
 * a request with no `Authorization` header.
 */
async function createCallerForUser(userId: string) {
  const user = await findUserById(userId);
  if (!user) throw new Error(`Test user not found: ${userId}`);
  return createCaller({
    user,
    authViaToken: false,
    credential: 'session',
    tokenSource: null,
    headersList: new Headers(),
  });
}

/**
 * An API-token caller for the same already-authenticated user: exactly what the boundary derives
 * from an `Authorization` header (`human_bearer`). A delegated or internal token classifies the
 * same way for the purposes of the start guard, so one bearer fixture covers them.
 */
async function createBearerCallerForUser(userId: string) {
  const user = await findUserById(userId);
  if (!user) throw new Error(`Test user not found: ${userId}`);
  return createCaller({
    user,
    authViaToken: true,
    credential: 'human_bearer',
    tokenSource: null,
    headersList: new Headers({ Authorization: `Bearer ${generateApiToken(user)}` }),
  });
}

const mockedQuote = jest.mocked(requestPaidBenchmarkQuote);
const mockedStart = jest.mocked(startPaidBenchmark);
const mockedProgress = jest.mocked(getPaidBenchmarkProgress);
const mockedPause = jest.mocked(pausePaidBenchmark);
const mockedTable = jest.mocked(getCustomRouterTable);
const mockedBlocked = jest.mocked(lookupCustomRouterBlockedModels);

const SONNET = 'anthropic/claude-sonnet-4';
const REQUEST_ID = '3f1c0c3e-1d15-4e3e-9d4a-32f6b0a1c111';

const entries = (): CustomRouterEntry[] => [{ kind: 'gateway', model: SONNET }];

type ProgressStatus = 'preparing' | 'active' | 'paused';

function progress(status: ProgressStatus): PaidBenchmarkProgress {
  const fields = {
    id: REQUEST_ID,
    estimateMicrodollars: 1_500,
    maximumMicrodollars: 2_000,
    chargedMicrodollars: 0,
    billedModelRequests: 1,
    kiloCoveredModelRequests: 0,
    kiloCoveredMicrodollars: 0,
    counts: { queued: 0, running: 0, reused: 0, done: 0, failed: 0, paused: 0 },
    cases: [],
    nextCursor: null,
  };
  switch (status) {
    case 'preparing':
      return { status, ...fields };
    case 'active':
      return { status, ...fields };
    case 'paused':
      return { status, ...fields, reason: null };
  }
}

async function createRouter(params: {
  userId?: string;
  organizationId?: string;
  slug?: string;
  entries?: CustomRouterEntry[];
}) {
  const pool = params.entries ?? entries();
  const [row] = await db
    .insert(auto_routing_custom_routers)
    .values({
      owned_by_user_id: params.userId ?? null,
      owned_by_organization_id: params.organizationId ?? null,
      created_by_user_id: params.userId ?? 'fixture-creator',
      slug: params.slug ?? 'coding',
      name: 'Coding',
      base_router: 'efficient',
      mode: 'cost_per_accuracy',
      entries: pool,
      default_entry_key: customRouterEntryKey(pool[0]),
    })
    .returning();
  if (!row) throw new Error('Custom router insert returned no row');
  return row;
}

describe('customRouterBenchmarks', () => {
  let user: User;

  beforeEach(async () => {
    jest.resetAllMocks();
    user = await insertTestUser();
    mockedQuote.mockResolvedValue({ ok: true, body: { status: 'empty' } });
    mockedProgress.mockResolvedValue({ ok: true, body: { status: 'empty' } });
    mockedTable.mockResolvedValue({ status: 200, body: { table: null } });
  });

  afterEach(async () => {
    await cleanupDbForTest();
  });

  test('reports blocked models for the editor without writing', async () => {
    const failure = {
      kind: 'permanent',
      failureClass: 'catalog_absent',
      reason: 'model is gone from the catalog',
      attempts: 6,
      firstFailedAt: '2026-11-19T00:00:00.000Z',
      lastFailedAt: '2026-11-19T01:00:00.000Z',
      cause: 'terminal_class',
    } as const;
    mockedBlocked.mockResolvedValue({
      router: 'frontier',
      blocked: [{ model: SONNET, pair: { model: SONNET, variant: 'high' }, failure }],
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.customRouterBenchmarks.blockedModels({
      models: [SONNET],
      baseRouter: 'frontier',
    });

    expect(result).toEqual({
      router: 'frontier',
      blocked: [{ model: SONNET, pair: { model: SONNET, variant: 'high' }, failure }],
    });
    expect(mockedBlocked).toHaveBeenCalledWith({ router: 'frontier', models: [SONNET] });
  });

  test('maps a failed blocked-model lookup to the retryable state', async () => {
    mockedBlocked.mockRejectedValue(new Error('benchmark worker is not configured'));

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.customRouterBenchmarks.blockedModels({ models: [SONNET], baseRouter: 'efficient' })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  test('quotes the authorized saved pool for its owner', async () => {
    const row = await createRouter({ userId: user.id });
    const quote: PaidBenchmarkQuote = {
      status: 'ready',
      id: REQUEST_ID,
      expiresAt: new Date().toISOString(),
      estimateMicrodollars: 1_500,
      maximumMicrodollars: 2_000,
      cases: { reused: 1, covered: 0, shared: 0, exclusive: 2 },
      aliases: [{ model: 'anthropic/claude-sonnet-4-latest', target: SONNET }],
    };
    mockedQuote.mockResolvedValue({ ok: true, body: quote });

    const caller = await createCallerForUser(user.id);
    const result = await caller.customRouterBenchmarks.quote({ slug: 'coding' });

    expect(result).toEqual(quote);
    expect(mockedQuote).toHaveBeenCalledWith({
      action: 'quote',
      ownerType: 'user',
      ownerId: user.id,
      routerId: row.id,
      poolSlug: 'coding',
      poolVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
      context: {
        ownerType: 'user',
        ownerId: user.id,
        baseRouter: 'efficient',
        entries: entries(),
        clientEvalEntryKeys: [],
      },
    });
  });

  test('serves the saved pin to table and status while the pool identity stays stable', async () => {
    await createRouter({ userId: user.id });
    const caller = await createCallerForUser(user.id);
    const pin = {
      model: SONNET,
      pinnedAt: '2026-11-20T12:00:00.000Z',
      confirmedAt: '2026-11-20T11:00:00.000Z',
    };
    const pinned: CustomRouterEntry[] = [{ kind: 'gateway', model: SONNET, servingPin: pin }];
    await db
      .update(auto_routing_custom_routers)
      .set({ entries: pinned })
      .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));

    // The routing table and the per-entry status keep the pinned target: both read the full saved
    // pool, so dropping the pin from the benchmark context would silently stop alias continuity.
    await caller.customRouterBenchmarks.table({ slug: 'coding' });
    expect(mockedTable).toHaveBeenLastCalledWith(expect.objectContaining({ entries: pinned }));

    // A quote issued now is bound to the pin-free identity, so a later pin-only write cannot
    // invalidate it, while the concrete model still moves the identity.
    await caller.customRouterBenchmarks.quote({ slug: 'coding' });
    const before = mockedQuote.mock.calls[0]?.[0];
    if (!before) throw new Error('expected a quote request');
    expect(before.context.entries).toEqual(pinned);

    await caller.customRouterBenchmarks.quote({ slug: 'coding' });
    expect(mockedQuote.mock.calls[1]?.[0]?.poolVersion).toBe(before.poolVersion);

    await db
      .update(auto_routing_custom_routers)
      .set({ entries: [{ kind: 'gateway', model: 'anthropic/claude-sonnet-4-5' }] })
      .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
    await caller.customRouterBenchmarks.quote({ slug: 'coding' });
    expect(mockedQuote.mock.calls[2]?.[0]?.poolVersion).not.toBe(before.poolVersion);
  });

  test('keeps one quote identity across a pin publication and a no-op re-registration', async () => {
    await createRouter({ userId: user.id });
    const caller = await createCallerForUser(user.id);
    await caller.customRouterBenchmarks.quote({ slug: 'coding' });
    const before = mockedQuote.mock.calls[0]?.[0];
    if (!before) throw new Error('expected a quote request');

    // A settlement publishes a serving pin onto the saved row.
    const pinned: CustomRouterEntry[] = [
      {
        kind: 'gateway',
        model: SONNET,
        servingPin: {
          model: SONNET,
          pinnedAt: '2026-11-20T12:00:00.000Z',
          confirmedAt: '2026-11-20T11:00:00.000Z',
        },
      },
    ];
    await db
      .update(auto_routing_custom_routers)
      .set({ entries: pinned })
      .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
    await caller.customRouterBenchmarks.quote({ slug: 'coding' });
    const afterPin = mockedQuote.mock.calls[1]?.[0];
    // The pool identity a quote is bound to is unchanged; only the served context gained the pin.
    expect(afterPin?.poolVersion).toBe(before.poolVersion);

    // The CLI re-registers the same gateway entry with refreshed pricing.
    await db
      .update(auto_routing_custom_routers)
      .set({
        entries: [{ kind: 'gateway', model: SONNET }],
      })
      .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
    await caller.customRouterBenchmarks.quote({ slug: 'coding' });
    const afterReRegister = mockedQuote.mock.calls[2]?.[0];
    expect(afterReRegister?.poolVersion).toBe(before.poolVersion);

    // A genuine concrete target change is a different measurement identity.
    await db
      .update(auto_routing_custom_routers)
      .set({ entries: [{ kind: 'gateway', model: 'anthropic/claude-sonnet-4-5' }] })
      .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
    await caller.customRouterBenchmarks.quote({ slug: 'coding' });
    const afterModelChange = mockedQuote.mock.calls[3]?.[0];
    expect(afterModelChange?.poolVersion).not.toBe(before.poolVersion);
  });

  test('does not read another user’s pool', async () => {
    await createRouter({ userId: user.id });
    const other = await insertTestUser();
    const caller = await createCallerForUser(other.id);

    await expect(caller.customRouterBenchmarks.quote({ slug: 'coding' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller.customRouterBenchmarks.table({ slug: 'coding' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mockedQuote).not.toHaveBeenCalled();
  });

  test('lets an organization member read but reserves start for admins and pause for billing roles', async () => {
    const organization = await createTestOrganization('Acme', user.id, 0);
    const row = await createRouter({ organizationId: organization.id });
    const member = await insertTestUser();
    const billingManager = await insertTestUser();
    await db.insert(organization_memberships).values([
      { organization_id: organization.id, kilo_user_id: member.id, role: 'member' },
      {
        organization_id: organization.id,
        kilo_user_id: billingManager.id,
        role: 'billing_manager',
      },
    ]);

    const memberCaller = await createCallerForUser(member.id);
    await expect(
      memberCaller.customRouterBenchmarks.quote({
        slug: 'coding',
        organizationId: organization.id,
      })
    ).resolves.toEqual({ status: 'empty' });
    await expect(
      memberCaller.customRouterBenchmarks.start({
        slug: 'coding',
        organizationId: organization.id,
        quoteId: REQUEST_ID,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      memberCaller.customRouterBenchmarks.pause({
        slug: 'coding',
        organizationId: organization.id,
        requestId: REQUEST_ID,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockedStart).not.toHaveBeenCalled();

    // A billing manager can stop spend but holds no spending authority in the ledger, so start is
    // refused and pause is allowed.
    const billingCaller = await createCallerForUser(billingManager.id);
    await expect(
      billingCaller.customRouterBenchmarks.start({
        slug: 'coding',
        organizationId: organization.id,
        quoteId: REQUEST_ID,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockedStart).not.toHaveBeenCalled();
    mockedPause.mockResolvedValue({ ok: true, body: progress('paused') });
    await expect(
      billingCaller.customRouterBenchmarks.pause({
        slug: 'coding',
        organizationId: organization.id,
        requestId: REQUEST_ID,
      })
    ).resolves.toMatchObject({ status: 'paused' });

    // The organization owner holds spending authority and derives the owner from the saved row.
    mockedStart.mockResolvedValue({
      ok: true,
      body: { status: 'started', request: progress('active') },
    });
    const ownerCaller = await createCallerForUser(user.id);
    await expect(
      ownerCaller.customRouterBenchmarks.start({
        slug: 'coding',
        organizationId: organization.id,
        quoteId: REQUEST_ID,
      })
    ).resolves.toMatchObject({ status: 'started' });
    expect(mockedStart).toHaveBeenCalledWith({
      action: 'start',
      ownerType: 'org',
      ownerId: organization.id,
      routerId: row.id,
      poolSlug: 'coding',
      poolVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
      context: expect.objectContaining({ ownerType: 'org', ownerId: organization.id }),
      quoteId: REQUEST_ID,
      actorUserId: user.id,
    });
  });

  test('returns a credit refusal as a typed start result instead of an error', async () => {
    await createRouter({ userId: user.id });
    mockedStart.mockResolvedValue({
      ok: true,
      body: {
        status: 'insufficient_balance',
        requiredMicrodollars: 5_000,
        availableMicrodollars: 10,
      },
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.customRouterBenchmarks.start({ slug: 'coding', quoteId: REQUEST_ID })
    ).resolves.toEqual({
      status: 'insufficient_balance',
      requiredMicrodollars: 5_000,
      availableMicrodollars: 10,
    });
  });

  test('refuses a start from an API token for the correct owner, before the Worker', async () => {
    // A valid bearer token belonging to the pool's own owner, and a live quote in hand: this is
    // exactly the automated click the rule forbids, so it must be refused at HTTP with no
    // Worker call at all.
    await createRouter({ userId: user.id });
    mockedQuote.mockResolvedValue({
      ok: true,
      body: {
        status: 'ready',
        id: REQUEST_ID,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        estimateMicrodollars: 1_500,
        maximumMicrodollars: 2_000,
        cases: { reused: 0, covered: 0, shared: 0, exclusive: 2 },
        aliases: [],
      },
    });

    const bearerCaller = await createBearerCallerForUser(user.id);
    // The quote itself is allowed for that credential: only starting is reserved for the browser.
    await expect(
      bearerCaller.customRouterBenchmarks.quote({ slug: 'coding' })
    ).resolves.toMatchObject({ status: 'ready' });
    await expect(
      bearerCaller.customRouterBenchmarks.start({ slug: 'coding', quoteId: REQUEST_ID })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Start a benchmark from the Kilo web app, not from an API token.',
    });
    expect(mockedStart).not.toHaveBeenCalled();
  });

  test('refuses a start when the context carries no derived browser credential', async () => {
    await createRouter({ userId: user.id });
    // A context assembled without the boundary's classification must fail closed: the guard
    // cannot prove a human browser session, so it does not spend.
    const caller = createCaller({ user, headersList: new Headers() });
    await expect(
      caller.customRouterBenchmarks.start({ slug: 'coding', quoteId: REQUEST_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockedStart).not.toHaveBeenCalled();
  });

  test('serializes a start against a pool edit instead of admitting a stale pool', async () => {
    const row = await createRouter({ userId: user.id });
    let editBlocked = false;
    mockedStart.mockImplementation(async () => {
      // A start holds the owner advisory lock for its Worker call, so an edit or delete cannot
      // commit between the authorized read and the Worker's durable admission.
      try {
        await db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL statement_timeout = '500ms'`);
          await lockOwner(tx, { type: 'user', id: user.id });
        });
      } catch {
        editBlocked = true;
      }
      return { ok: true, body: { status: 'started', request: progress('active') } };
    });
    mockedPause.mockResolvedValue({ ok: true, body: progress('paused') });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.customRouterBenchmarks.start({ slug: 'coding', quoteId: REQUEST_ID })
    ).resolves.toMatchObject({ status: 'started' });

    expect(editBlocked).toBe(true);
    // The save path never admits, quotes, or starts a benchmark on its own.
    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(mockedQuote).not.toHaveBeenCalled();
    expect(mockedPause).not.toHaveBeenCalled();
    expect(row.id).toBeDefined();
  });

  test('passes the request and cursor through progress', async () => {
    await createRouter({ userId: user.id });
    mockedProgress.mockResolvedValue({ ok: true, body: progress('preparing') });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.customRouterBenchmarks.progress({
        slug: 'coding',
        requestId: REQUEST_ID,
        cursor: 'p2',
      })
    ).resolves.toMatchObject({ status: 'preparing' });

    expect(mockedProgress).toHaveBeenCalledWith({
      action: 'progress',
      ownerType: 'user',
      ownerId: user.id,
      routerId: expect.any(String),
      requestId: REQUEST_ID,
      cursor: 'p2',
    });
  });

  test('returns the serving table for the pool', async () => {
    await createRouter({ userId: user.id });
    const caller = await createCallerForUser(user.id);

    await expect(caller.customRouterBenchmarks.table({ slug: 'coding' })).resolves.toEqual({
      table: null,
    });
    expect(mockedTable).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: 'user', ownerId: user.id, baseRouter: 'efficient' })
    );
  });

  test('maps a transport failure to the retryable timeout state', async () => {
    await createRouter({ userId: user.id });
    mockedQuote.mockResolvedValue({
      ok: false,
      status: 504,
      error: { code: 'timeout', message: 'The benchmark worker did not answer in time' },
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.customRouterBenchmarks.quote({ slug: 'coding' })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});

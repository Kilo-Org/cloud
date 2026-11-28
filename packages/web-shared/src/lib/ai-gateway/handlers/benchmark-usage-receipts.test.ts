import { describe, it, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import type * as ServerConfig from '@kilocode/web-shared/lib/config.server';
import type * as AdminClient from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import type { PaidBenchmarkWorkerResult } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { insertUsageRecord } from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { defineMicrodollarUsage } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import { microdollar_usage } from '@kilocode/db/schema';
import {
  BENCHMARK_PLATFORM_PROJECT_ID,
  benchmarkProjectId,
  type PaidBenchmarkProgress,
} from '@kilocode/auto-routing-contracts';

/**
 * The pause client resolves its Worker origin at module load, and both the route and the client
 * read the internal secret at load too. Pinning both here keeps the file deterministic: loopback
 * origin, known secret, and no dependence on the ambient test env file.
 */
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<typeof ServerConfig>('@kilocode/web-shared/lib/config.server'),
  AUTO_ROUTING_BENCHMARK_WORKER_URL: 'http://127.0.0.1:9',
  INTERNAL_API_SECRET: 'benchmark-receipts-test-secret',
}));

let internalApiSecret: string;
let pausePoolBenchmark: typeof AdminClient.pausePoolBenchmark;
/** The handler as the web route serves it under its legacy credential. */
let handleBenchmarkUsageReceipts: (request: Request) => Promise<Response>;

beforeAll(async () => {
  jest.resetModules();
  ({ INTERNAL_API_SECRET: internalApiSecret } =
    await import('@kilocode/web-shared/lib/config.server'));
  ({ pausePoolBenchmark } =
    await import('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client'));
  const receipts = await import('./benchmark-usage-receipts');
  handleBenchmarkUsageReceipts = request =>
    receipts.handleBenchmarkUsageReceipts(request, receipts.authorizeBenchmarkUsageReceiptsLegacy);
});

const ROUTER_ID = '6f1c2f3a-1111-4a2b-8c3d-4e5f60718293';

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://app.kilo.ai/api/internal/usage/receipts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function authorized(body: unknown) {
  return request(body, { 'x-internal-api-key': internalApiSecret });
}

type Receipt = {
  usageId: string;
  status: string;
  microdollars: number | null;
  payerType: string | null;
  payerId: string | null;
  projectId: string | null;
  requestedModel: string | null;
  model: string | null;
};

/** Inserts a bare usage row, which is all the receipt read looks at. */
async function insertUsageRow(row: {
  id: string;
  kilo_user_id: string;
  cost: number;
  project_id: string | null;
  organization_id?: string | null;
  model?: string | null;
  requested_model?: string | null;
}): Promise<void> {
  await db.insert(microdollar_usage).values({
    id: row.id,
    kilo_user_id: row.kilo_user_id,
    organization_id: row.organization_id ?? null,
    cost: row.cost,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    model: row.model ?? 'openai/gpt-4o',
    requested_model: row.requested_model ?? 'openai/gpt-4o',
    project_id: row.project_id,
  });
}

const RECORDED_ID = '44444444-4444-4444-8444-444444444444';
const PENDING_ID = '55555555-5555-4555-8555-555555555555';
// Cleanup runs once per file, so every case inserts its own ids instead of reusing one.
const OUTSIDER_ID = 'a1111111-1111-4111-8111-111111111111';
const PLATFORM_ID = 'b2222222-2222-4222-8222-222222222222';
const ORG_PAYER_ID = 'c3333333-3333-4333-8333-333333333333';

describe('handleBenchmarkUsageReceipts', () => {
  const projectId = benchmarkProjectId({ scope: 'user', slug: 'p', routerId: ROUTER_ID });

  it('rejects a request without the internal secret', async () => {
    const response = await handleBenchmarkUsageReceipts(request({ usageIds: [RECORDED_ID] }));
    expect(response.status).toBe(401);
  });

  it('rejects an invalid body', async () => {
    const response = await handleBenchmarkUsageReceipts(authorized({ usageIds: [] }));
    expect(response.status).toBe(400);
  });

  it('reports a recorded row and leaves an absent id pending', async () => {
    await insertUsageRow({
      id: RECORDED_ID,
      kilo_user_id: 'test-receipt-branch-user',
      cost: 1234,
      project_id: projectId,
      model: 'openai/gpt-4o-2026-01-01',
      requested_model: 'openai/gpt-4o',
    });

    const body = (await (
      await handleBenchmarkUsageReceipts(authorized({ usageIds: [RECORDED_ID, PENDING_ID] }))
    ).json()) as { receipts: Receipt[] };

    expect(body.receipts).toEqual([
      expect.objectContaining({
        usageId: RECORDED_ID,
        status: 'recorded',
        microdollars: 1234,
        payerType: 'user',
        payerId: 'test-receipt-branch-user',
        projectId,
        requestedModel: 'openai/gpt-4o',
        model: 'openai/gpt-4o-2026-01-01',
      }),
      {
        usageId: PENDING_ID,
        status: 'pending',
        microdollars: null,
        payerType: null,
        payerId: null,
        projectId: null,
        requestedModel: null,
        model: null,
        createdAt: null,
      },
    ]);
  });

  it('never discloses a row outside the benchmark project namespace', async () => {
    await insertUsageRow({
      id: OUTSIDER_ID,
      kilo_user_id: 'test-receipt-outsider',
      cost: 999,
      project_id: 'handbook',
      model: 'anthropic/claude',
      requested_model: 'anthropic/claude',
    });

    const body = (await (
      await handleBenchmarkUsageReceipts(authorized({ usageIds: [OUTSIDER_ID] }))
    ).json()) as { receipts: Receipt[] };

    expect(body.receipts).toEqual([
      {
        usageId: OUTSIDER_ID,
        status: 'pending',
        microdollars: null,
        payerType: null,
        payerId: null,
        projectId: null,
        requestedModel: null,
        model: null,
        createdAt: null,
      },
    ]);
  });

  it('answers the reserved platform project', async () => {
    await insertUsageRow({
      id: PLATFORM_ID,
      kilo_user_id: 'test-receipt-platform',
      cost: 5,
      project_id: BENCHMARK_PLATFORM_PROJECT_ID,
    });

    const body = (await (
      await handleBenchmarkUsageReceipts(authorized({ usageIds: [PLATFORM_ID] }))
    ).json()) as { receipts: Receipt[] };
    expect(body.receipts[0]).toMatchObject({ status: 'recorded', microdollars: 5 });
  });

  it('reports an organization payer from organization_id', async () => {
    const organizationId = '7a1c2f3a-1111-4a2b-8c3d-4e5f60718293';
    await insertUsageRow({
      id: ORG_PAYER_ID,
      kilo_user_id: 'test-receipt-actor',
      organization_id: organizationId,
      cost: 0,
      project_id: benchmarkProjectId({ scope: 'org', slug: 'pool', routerId: ROUTER_ID }),
    });

    const body = (await (
      await handleBenchmarkUsageReceipts(authorized({ usageIds: [ORG_PAYER_ID] }))
    ).json()) as { receipts: Receipt[] };
    expect(body.receipts[0]).toMatchObject({
      payerType: 'organization',
      payerId: organizationId,
      microdollars: 0,
    });
  });
});

const FIRST_USAGE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_USAGE_ID = '22222222-2222-4222-8222-222222222222';
const FIRST_COST = 1_200;
const SECOND_COST = 4_800;
const REQUESTED_MODEL = 'openai/gpt-4o';

describe('benchmark receipts against the real usage writer', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('debits each priced write once and reports both exact costs after a pause', async () => {
    const user = await insertTestUser({
      id: 'test-benchmark-receipt-payer',
      microdollars_used: 0,
      total_microdollars_acquired: 10_000_000,
    });
    const projectId = benchmarkProjectId({
      scope: 'user',
      slug: 'paid-pool',
      routerId: ROUTER_ID,
    });

    const first = await defineMicrodollarUsage();
    await insertUsageRecord(
      {
        ...first.core,
        id: FIRST_USAGE_ID,
        kilo_user_id: user.id,
        cost: FIRST_COST,
        model: 'openai/gpt-4o-2026-01-01',
        requested_model: REQUESTED_MODEL,
        project_id: projectId,
      },
      { ...first.metadata, id: FIRST_USAGE_ID }
    );
    // The catalog price changed between the two admitted calls: the second row carries its own
    // native cost, and no advisory estimate bounds either write.
    const second = await defineMicrodollarUsage();
    await insertUsageRecord(
      {
        ...second.core,
        id: SECOND_USAGE_ID,
        kilo_user_id: user.id,
        cost: SECOND_COST,
        model: 'openai/gpt-4o-2026-02-01',
        requested_model: REQUESTED_MODEL,
        project_id: projectId,
      },
      { ...second.metadata, id: SECOND_USAGE_ID }
    );

    const rows = await db.query.microdollar_usage.findMany({
      where: (usage, { eq }) => eq(usage.kilo_user_id, user.id),
      orderBy: (usage, { asc }) => asc(usage.cost),
    });
    expect(rows.map(row => [row.cost, row.project_id])).toEqual([
      [FIRST_COST, projectId],
      [SECOND_COST, projectId],
    ]);

    // A redelivery of the known first native id is not a second debit.
    const retry = await defineMicrodollarUsage();
    const retryOutcome = await insertUsageRecord(
      {
        ...retry.core,
        id: FIRST_USAGE_ID,
        kilo_user_id: user.id,
        cost: FIRST_COST,
        model: 'openai/gpt-4o-2026-01-01',
        requested_model: REQUESTED_MODEL,
        project_id: projectId,
      },
      { ...retry.metadata, id: FIRST_USAGE_ID }
    );
    expect(retryOutcome).toMatchObject({ usageId: FIRST_USAGE_ID, wasRedelivery: true });

    const reloaded = await db.query.kilocode_users.findFirst({
      where: (users, { eq }) => eq(users.id, user.id),
    });
    expect(reloaded?.microdollars_used).toBe(FIRST_COST + SECOND_COST);
    expect(
      await db.query.microdollar_usage.findMany({
        where: (usage, { eq }) => eq(usage.kilo_user_id, user.id),
      })
    ).toHaveLength(2);

    // The actor pauses the request. Pause state lives in the benchmark Worker's store, and native
    // usage rows and their receipts never consult it, so both costs stay readable afterwards.
    // The transport is a local stub answering a paused progress body.
    const pausedProgress: PaidBenchmarkProgress = {
      status: 'paused',
      id: '33333333-3333-4333-8333-333333333333',
      estimateMicrodollars: FIRST_COST,
      maximumMicrodollars: FIRST_COST + SECOND_COST,
      chargedMicrodollars: FIRST_COST + SECOND_COST,
      billedModelRequests: 2,
      kiloCoveredModelRequests: 0,
      kiloCoveredMicrodollars: 0,
      counts: { queued: 0, running: 0, reused: 0, done: 0, failed: 0, paused: 1 },
      cases: [],
      nextCursor: null,
      reason: null,
    };
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json(pausedProgress));
    const paused: PaidBenchmarkWorkerResult<PaidBenchmarkProgress> = await pausePoolBenchmark({
      ownerType: 'user',
      ownerId: user.id,
      routerId: ROUTER_ID,
    });
    expect(paused).toEqual({ ok: true, body: pausedProgress });
    const pauseCall = fetchSpy.mock.calls[0];
    if (pauseCall === undefined) throw new Error('Expected the pause request');
    const [pauseUrl, pauseInit] = pauseCall;
    const url = pauseUrl instanceof Request ? new URL(pauseUrl.url) : new URL(pauseUrl);
    expect(url.pathname).toBe('/admin/custom-router-benchmark');
    expect(new Headers(pauseInit?.headers).get('authorization')).toBe(
      `Bearer ${internalApiSecret}`
    );
    if (typeof pauseInit?.body !== 'string') throw new Error('Expected a JSON pause body');
    expect(JSON.parse(pauseInit.body)).toEqual({
      action: 'pause',
      ownerType: 'user',
      ownerId: user.id,
      routerId: ROUTER_ID,
    });

    // A pause stops future work; it never rewrites what was already charged.
    expect(
      await db.query.microdollar_usage.findMany({
        where: (usage, { eq }) => eq(usage.kilo_user_id, user.id),
      })
    ).toHaveLength(2);
    expect(
      (
        await db.query.kilocode_users.findFirst({
          where: (users, { eq }) => eq(users.id, user.id),
        })
      )?.microdollars_used
    ).toBe(FIRST_COST + SECOND_COST);

    const response = await handleBenchmarkUsageReceipts(
      authorized({ usageIds: [FIRST_USAGE_ID, SECOND_USAGE_ID] })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { receipts: Receipt[] };
    expect(body.receipts).toEqual([
      expect.objectContaining({
        usageId: FIRST_USAGE_ID,
        status: 'recorded',
        microdollars: FIRST_COST,
        payerType: 'user',
        payerId: user.id,
        projectId,
        requestedModel: REQUESTED_MODEL,
        model: 'openai/gpt-4o-2026-01-01',
      }),
      expect.objectContaining({
        usageId: SECOND_USAGE_ID,
        status: 'recorded',
        microdollars: SECOND_COST,
        payerType: 'user',
        payerId: user.id,
        projectId,
        requestedModel: REQUESTED_MODEL,
        model: 'openai/gpt-4o-2026-02-01',
      }),
    ]);
  });
});

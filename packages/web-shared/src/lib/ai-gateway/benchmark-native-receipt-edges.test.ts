// Must run before any billing module loads its Stripe configuration.
import './benchmark-billing-test-env';
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import type * as ServerConfig from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, microdollar_usage } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { defineMicrodollarUsage } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import { benchmarkProjectId } from '@kilocode/auto-routing-contracts';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { eq } from 'drizzle-orm';

/**
 * Pause, abort and duplicate-dispatch edges where the *only* question is what the native
 * writer and the receipt read record. The transport is a fake `fetch`; nothing leaves the VM.
 */
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<typeof ServerConfig>('@kilocode/web-shared/lib/config.server'),
  AUTO_ROUTING_BENCHMARK_WORKER_URL: 'http://127.0.0.1:9',
  INTERNAL_API_SECRET: 'benchmark-receipts-edge-secret',
}));

import type * as ReceiptRoute from './handlers/benchmark-usage-receipts';
import type * as UsageWriter from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import type * as TerminalReceipt from '@kilocode/web-shared/lib/ai-gateway/terminal-no-charge-receipt';
import type * as Admission from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import type * as AccountAccess from '@kilocode/worker-utils/account-access';

const SECRET = 'benchmark-receipts-edge-secret';
const ROUTER_ID = '6f1c2f3a-1111-4a2b-8c3d-4e5f60718293';
const PROJECT = benchmarkProjectId({ scope: 'user', slug: 'paid-pool', routerId: ROUTER_ID });

let handleBenchmarkUsageReceipts: typeof ReceiptRoute.handleBenchmarkUsageReceipts;
let insertUsageRecord: typeof UsageWriter.insertUsageRecord;
let recordTerminalNoChargeReceipt: typeof TerminalReceipt.recordTerminalNoChargeReceipt;
let readGatewayBalance: typeof Admission.readGatewayBalance;
let canSpendPaidUsage: typeof AccountAccess.canSpendPaidUsage;

beforeAll(async () => {
  jest.resetModules();
  ({ handleBenchmarkUsageReceipts } = await import('./handlers/benchmark-usage-receipts'));
  ({ insertUsageRecord } = await import('@kilocode/web-shared/lib/ai-gateway/processUsage'));
  ({ recordTerminalNoChargeReceipt } =
    await import('@kilocode/web-shared/lib/ai-gateway/terminal-no-charge-receipt'));
  ({ readGatewayBalance } = await import('@kilocode/web-shared/lib/ai-gateway/gateway-admission'));
  ({ canSpendPaidUsage } = await import('@kilocode/worker-utils/account-access'));
});

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

async function readReceipts(usageIds: string[]): Promise<Receipt[]> {
  const response = await handleBenchmarkUsageReceipts(
    new Request('https://app.kilo.ai/api/internal/usage/receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-api-key': SECRET },
      body: JSON.stringify({ usageIds }),
    })
  );
  expect(response.status).toBe(200);
  const body: { receipts: Receipt[] } = await response.json();
  return body.receipts;
}

/** A benchmark usage context with every required field real; only `usageId` varies per call. */
function benchmarkContext(userId: string, usageId: string): MicrodollarUsageContext {
  return {
    api_kind: 'chat_completions' as const,
    kiloUserId: userId,
    fraudHeaders: EmptyFraudDetectionHeaders,
    provider: 'openrouter',
    requested_model: 'openai/gpt-4o',
    is_free: false,
    custom_llm_pricing: null,
    promptInfo: { system_prompt_length: 0 },
    max_tokens: 5,
    has_middle_out_transform: false,
    isStreaming: false,
    prior_microdollar_usage: 0,
    project_id: PROJECT,
    status_code: null,
    editor_name: null,
    machine_id: null,
    user_byok: false,
    has_tools: false,
    feature: null,
    session_id: null,
    mode: null,
    auto_model: null,
    reasoning_setting: null,
    inference_region: null,
    ttfb_ms: null,
    usageId,
  };
}

/** The real native writer, so every row and balance assertion is a committed fact. */
function nativeWriter(userId: string) {
  return async (
    stats: Parameters<TerminalReceipt.BenchmarkReceiptWriter>[0],
    context: Parameters<TerminalReceipt.BenchmarkReceiptWriter>[1]
  ) => {
    const usage = await defineMicrodollarUsage();
    const id = context.usageId ?? usage.core.id;
    await insertUsageRecord(
      {
        ...usage.core,
        id,
        kilo_user_id: userId,
        cost: stats.cost_mUsd,
        model: stats.model ?? 'openai/gpt-4o',
        requested_model: context.requested_model,
        project_id: context.project_id,
      },
      { ...usage.metadata, id }
    );
    return { usageId: id };
  };
}

async function spendOf(userId: string): Promise<number> {
  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
  return user?.microdollars_used ?? -1;
}

async function rowsOf(userId: string) {
  return db.query.microdollar_usage.findMany({
    where: eq(microdollar_usage.kilo_user_id, userId),
    orderBy: (usage, { asc }) => asc(usage.created_at),
  });
}

/**
 * A pause that lands after the Worker admitted the call but before the provider was dialled
 * must not bill, and must leave the payer's outstanding permit clearable. The gateway has no
 * provider response here, so it writes the same authoritative zero-cost terminal row it writes
 * for a definitive provider error.
 */
describe('paused before dispatch: no charge, exact zero receipt', () => {
  it('records a zero-cost row and never moves the balance', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 1_000_000,
    });
    const usageId = '11111111-aaaa-4111-8111-111111111111';

    const deferred: Promise<void>[] = [];
    recordTerminalNoChargeReceipt(
      benchmarkContext(user.id, usageId),
      400,
      nativeWriter(user.id),
      task => {
        deferred.push(task());
      }
    );
    await Promise.all(deferred);

    const receipts = await readReceipts([usageId]);
    expect(receipts).toEqual([
      expect.objectContaining({
        usageId,
        status: 'recorded',
        microdollars: 0,
        payerType: 'user',
        payerId: user.id,
        projectId: PROJECT,
      }),
    ]);

    expect(await spendOf(user.id)).toBe(0);
    const rows = await rowsOf(user.id);
    expect(rows.map(row => [row.id, row.cost])).toEqual([[usageId, 0]]);
  });

  it('is idempotent: the same paused usage id twice bills nothing and keeps one row', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 1_000_000,
    });
    const usageId = '22222222-bbbb-4222-8222-222222222222';
    const deferred: Promise<void>[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      recordTerminalNoChargeReceipt(
        benchmarkContext(user.id, usageId),
        400,
        nativeWriter(user.id),
        task => {
          deferred.push(task());
        }
      );
    }
    await Promise.all(deferred);

    const rows = await rowsOf(user.id);
    expect(rows.map(row => [row.id, row.cost])).toEqual([[usageId, 0]]);
    expect(await spendOf(user.id)).toBe(0);
    const [receipt] = await readReceipts([usageId]);
    expect(receipt).toMatchObject({ status: 'recorded', microdollars: 0 });
  });
});

/**
 * R28 duplicate dispatch: the same logical model request delivered twice must never produce a
 * second debit. `insertUsageRecord` deduplicates on the signed usage id, so a replayed callback
 * is a redelivery, not a charge.
 */
describe('duplicate dispatch: one debit per signed usage id', () => {
  it('charges once when the identical call is written twice', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 1_000_000,
    });
    const usageId = '33333333-cccc-4333-8333-333333333333';
    const cost = 3_700;

    const write = async () => {
      const usage = await defineMicrodollarUsage();
      return insertUsageRecord(
        {
          ...usage.core,
          id: usageId,
          kilo_user_id: user.id,
          cost,
          model: 'openai/gpt-4o',
          requested_model: 'openai/gpt-4o',
          project_id: PROJECT,
        },
        { ...usage.metadata, id: usageId }
      );
    };

    const first = await write();
    const second = await write();

    expect(first).toMatchObject({ usageId, wasRedelivery: false });
    expect(second).toMatchObject({ usageId, wasRedelivery: true });
    expect(await spendOf(user.id)).toBe(cost);
    expect((await rowsOf(user.id)).map(row => row.cost)).toEqual([cost]);
  });

  it('does not admit a next call on a stale snapshot after an ordinary debit', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 1_000_000,
    });
    // The exact ordinary-debit shape R48 describes: a compliant write crosses the balance.
    const usage = await defineMicrodollarUsage();
    await insertUsageRecord(
      {
        ...usage.core,
        id: '44444444-dddd-4444-8444-444444444444',
        kilo_user_id: user.id,
        cost: 1_000_000,
        model: 'openai/gpt-4o',
        requested_model: 'openai/gpt-4o',
        project_id: 'handbook',
      },
      { ...usage.metadata, id: '44444444-dddd-4444-8444-444444444444' }
    );

    const reloaded = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    if (!reloaded) throw new Error('user row missing');
    // What a fresh admission reads: the committed primary value, not a pre-debit snapshot.
    const account = await readGatewayBalance(reloaded, undefined, 'openai/gpt-4o', {
      noAutoTopUp: true,
      fresh: true,
    });
    expect(canSpendPaidUsage(account.balance)).toBe(false);
  });
});

/**
 * A provider call the runner cancelled mid-stream still incurred cost once it returned a
 * response. The native writer bills it; the cancellation must not suppress or duplicate it.
 */
describe('runner cancellation after an accepted call', () => {
  it('keeps exactly one charge for a cancelled admitted generation', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 1_000_000,
    });
    const usageId = '55555555-eeee-4555-8555-555555555555';
    const cost = 2_100;

    const usage = await defineMicrodollarUsage();
    await insertUsageRecord(
      {
        ...usage.core,
        id: usageId,
        kilo_user_id: user.id,
        cost,
        model: 'openai/gpt-4o',
        requested_model: 'openai/gpt-4o',
        project_id: PROJECT,
      },
      { ...usage.metadata, id: usageId, cancelled: true }
    );

    // A cancellation annotation on the row does not zero or drop the cost.
    const rows = await rowsOf(user.id);
    expect(rows.map(row => [row.id, row.cost])).toEqual([[usageId, cost]]);
    expect(await spendOf(user.id)).toBe(cost);
    const [receipt] = await readReceipts([usageId]);
    expect(receipt).toMatchObject({ status: 'recorded', microdollars: cost });
  });

  it('never revives a cancelled generation as a second debit', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 1_000_000,
    });
    const usageId = '66666666-ffff-4666-8666-666666666666';
    const cost = 900;

    for (const cancelled of [false, true]) {
      const usage = await defineMicrodollarUsage();
      await insertUsageRecord(
        {
          ...usage.core,
          id: usageId,
          kilo_user_id: user.id,
          cost,
          model: 'openai/gpt-4o',
          requested_model: 'openai/gpt-4o',
          project_id: PROJECT,
        },
        { ...usage.metadata, id: usageId, cancelled }
      );
    }

    expect(await spendOf(user.id)).toBe(cost);
    expect((await rowsOf(user.id)).length).toBe(1);
  });
});

/**
 * An uncertain dispatch (no affirmative provider answer, no refusal) must stay `pending`: no
 * zero receipt, no charge, and nothing the Worker could mistake for a settled permit.
 */
describe('uncertain dispatch stays pending', () => {
  it('writes no row and reports pending for an id the writer never saw', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 1_000_000,
    });
    const usageId = '77777777-aaaa-4777-8777-777777777777';
    // Nothing wrote a row for this id: an aborted or unknown dispatch never reaches the writer,
    // which is exactly the point.

    const [receipt] = await readReceipts([usageId]);
    expect(receipt).toEqual({
      usageId,
      status: 'pending',
      microdollars: null,
      payerType: null,
      payerId: null,
      projectId: null,
      requestedModel: null,
      model: null,
      createdAt: null,
    });
    expect(await rowsOf(user.id)).toEqual([]);
    expect(await spendOf(user.id)).toBe(0);
  });
});

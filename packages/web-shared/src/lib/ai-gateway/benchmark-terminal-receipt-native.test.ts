// First, so the billing modules see their placeholders before they load.
import './benchmark-billing-test-env';
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import type * as ServerConfig from '@kilocode/web-shared/lib/config.server';
const SECRET = 'benchmark-terminal-receipt-native-secret';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { defineMicrodollarUsage } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import { benchmarkProjectId } from '@kilocode/auto-routing-contracts';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';

const ROUTER_ID = '6f1c2f3a-1111-4a2b-8c3d-4e5f60718293';
const NO_CHARGE_USAGE_ID = '44444444-4444-4444-8444-444444444444';
const CHARGED_USAGE_ID = '55555555-5555-4555-8555-555555555555';
const CHARGED_COST = 4_200;

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<typeof ServerConfig>('@kilocode/web-shared/lib/config.server'),
  AUTO_ROUTING_BENCHMARK_WORKER_URL: 'http://127.0.0.1:9',
  INTERNAL_API_SECRET: 'benchmark-terminal-receipt-native-secret',
}));

import type * as UsageWriter from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import type * as TerminalReceipt from '@kilocode/web-shared/lib/ai-gateway/terminal-no-charge-receipt';

/** The handler as the web route serves it under its legacy credential. */
let handleBenchmarkUsageReceipts: (request: Request) => Promise<Response>;
let insertUsageRecord: typeof UsageWriter.insertUsageRecord;
let recordTerminalNoChargeReceipt: typeof TerminalReceipt.recordTerminalNoChargeReceipt;

beforeAll(async () => {
  jest.resetModules();
  const receipts = await import('./handlers/benchmark-usage-receipts');
  handleBenchmarkUsageReceipts = request =>
    receipts.handleBenchmarkUsageReceipts(request, receipts.authorizeBenchmarkUsageReceiptsLegacy);
  ({ insertUsageRecord } = await import('@kilocode/web-shared/lib/ai-gateway/processUsage'));
  ({ recordTerminalNoChargeReceipt } =
    await import('@kilocode/web-shared/lib/ai-gateway/terminal-no-charge-receipt'));
});

function receiptRequest(usageIds: string[]) {
  return new Request('https://app.kilo.ai/api/internal/usage/receipts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-api-key': SECRET },
    body: JSON.stringify({ usageIds }),
  });
}

async function readReceipts(usageIds: string[]) {
  const response = await handleBenchmarkUsageReceipts(receiptRequest(usageIds));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    receipts: { usageId: string; status: string; microdollars: number | null }[];
  };
  return body.receipts;
}

/**
 * The strand this proves closed: an admitted benchmark call whose provider answered a
 * definitive error used to leave no native usage row, so the Worker's receipt read stayed
 * `pending` forever and the payer could never be admitted again. The gateway now writes an
 * authoritative zero-cost row through the real writer; this drives that writer against
 * PostgreSQL, reads the receipt through the real route, and then charges a second call.
 */
describe('terminal no-charge receipt through the real native writer', () => {
  it('clears the admitted-without-receipt state, then the next call charges', async () => {
    const user = await insertTestUser({
      google_user_email: `bench-terminal-${crypto.randomUUID()}@example.com`,
      microdollars_used: 0,
      total_microdollars_acquired: 10_000_000,
    });
    const projectId = benchmarkProjectId({ scope: 'user', slug: 'paid-pool', routerId: ROUTER_ID });

    // First admitted call: the provider answered a definitive error, so the gateway writes the
    // terminal no-charge row. The deferral is captured and awaited, matching `after()` semantics
    // without a wall-clock wait.
    const deferred: Promise<void>[] = [];
    const usage = await defineMicrodollarUsage();
    recordTerminalNoChargeReceipt(
      {
        api_kind: 'chat_completions',
        kiloUserId: user.id,
        fraudHeaders: EmptyFraudDetectionHeaders,
        provider: 'openrouter',
        requested_model: 'openai/gpt-4o',
        is_free: false,
        custom_llm_pricing: null,
        promptInfo: { system_prompt_length: 0, system_prompt_kind: null },
        max_tokens: 5,
        has_middle_out_transform: false,
        isStreaming: false,
        prior_microdollar_usage: 0,
        project_id: projectId,
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
        usageId: NO_CHARGE_USAGE_ID,
      },
      400,
      async (stats, context) => {
        await insertUsageRecord(
          {
            ...usage.core,
            id: context.usageId as string,
            kilo_user_id: user.id,
            cost: stats.cost_mUsd,
            model: stats.model ?? 'openai/gpt-4o',
            requested_model: context.requested_model,
            project_id: context.project_id,
          },
          { ...usage.metadata, id: context.usageId as string }
        );
      },
      task => {
        deferred.push(task());
      }
    );
    await Promise.all(deferred);

    const firstReceipts = await readReceipts([NO_CHARGE_USAGE_ID]);
    expect(firstReceipts).toEqual([
      {
        usageId: NO_CHARGE_USAGE_ID,
        status: 'recorded',
        microdollars: 0,
        payerType: 'user',
        payerId: user.id,
        projectId,
        requestedModel: 'openai/gpt-4o',
        model: 'openai/gpt-4o',
        createdAt: expect.any(String),
      },
    ]);

    // No balance moved for a zero receipt.
    const afterFirst = await db.query.kilocode_users.findFirst({
      where: (users, { eq }) => eq(users.id, user.id),
    });
    expect(afterFirst?.microdollars_used).toBe(0);

    // Second admitted call, now that no receipt is outstanding: it charges normally.
    const second = await defineMicrodollarUsage();
    await insertUsageRecord(
      {
        ...second.core,
        id: CHARGED_USAGE_ID,
        kilo_user_id: user.id,
        cost: CHARGED_COST,
        model: 'openai/gpt-4o-2026-01-01',
        requested_model: 'openai/gpt-4o',
        project_id: projectId,
      },
      { ...second.metadata, id: CHARGED_USAGE_ID }
    );

    // The receipt is visible immediately, not on the next reconciliation pass.
    const secondReceipts = await readReceipts([CHARGED_USAGE_ID]);
    expect(secondReceipts[0]).toMatchObject({
      usageId: CHARGED_USAGE_ID,
      status: 'recorded',
      microdollars: CHARGED_COST,
      requestedModel: 'openai/gpt-4o',
      projectId,
    });

    const charged = await db.query.kilocode_users.findFirst({
      where: (users, { eq }) => eq(users.id, user.id),
    });
    expect(charged?.microdollars_used).toBe(CHARGED_COST);

    const rows = await db.query.microdollar_usage.findMany({
      where: (usage, { eq }) => eq(usage.kilo_user_id, user.id),
      orderBy: (usage, { asc }) => asc(usage.cost),
    });
    expect(rows.map(row => [row.id, row.cost])).toEqual([
      [NO_CHARGE_USAGE_ID, 0],
      [CHARGED_USAGE_ID, CHARGED_COST],
    ]);
  });

  it('leaves a transport-unknown call pending, with no row and no charge', async () => {
    const user = await insertTestUser({
      google_user_email: `bench-terminalless-${crypto.randomUUID()}@example.com`,
      microdollars_used: 0,
      total_microdollars_acquired: 10_000_000,
    });
    const unknownUsageId = '66666666-6666-4666-8666-666666666666';
    // An abort or unknown outcome never calls the terminal-receipt writer, so no row exists.
    const receipts = await readReceipts([unknownUsageId]);
    expect(receipts).toEqual([
      {
        usageId: unknownUsageId,
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
    const rows = await db.query.microdollar_usage.findMany({
      where: (usage, { eq }) => eq(usage.kilo_user_id, user.id),
    });
    expect(rows).toEqual([]);
    const unchanged = await db.query.kilocode_users.findFirst({
      where: (users, { eq }) => eq(users.id, user.id),
    });
    expect(unchanged?.microdollars_used).toBe(0);
  });
});

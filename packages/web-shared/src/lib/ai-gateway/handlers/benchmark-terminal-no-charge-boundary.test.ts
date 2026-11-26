// Must run before any billing module loads its Stripe configuration.
import '../benchmark-billing-test-env';
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import type * as ServerConfig from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { microdollar_usage } from '@kilocode/db/schema';
import type * as NextServer from 'next/server';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { defineMicrodollarUsage } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import { benchmarkProjectId } from '@kilocode/auto-routing-contracts';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<typeof ServerConfig>('@kilocode/web-shared/lib/config.server'),
  AUTO_ROUTING_BENCHMARK_WORKER_URL: 'http://127.0.0.1:9',
  INTERNAL_API_SECRET: 'benchmark-terminal-receipt-secret',
}));

// `upstreamRequest` schedules a listener cleanup with `after`, which needs a Next request
// scope. These tests call the provider layer directly, so the deferral is collected instead.
const deferredAfter: Promise<unknown>[] = [];
jest.mock('next/server', () => {
  const actual = jest.requireActual<typeof NextServer>('next/server');
  return {
    ...actual,
    after: (task: (() => unknown) | Promise<unknown>) => {
      deferredAfter.push(typeof task === 'function' ? Promise.resolve(task()) : task);
    },
  };
});

import type * as ProxyModule from './llm-proxy';
import type * as UpstreamRequest from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import type * as TerminalReceipt from '@kilocode/web-shared/lib/ai-gateway/terminal-no-charge-receipt';
import type * as ReceiptRoute from './benchmark-usage-receipts';
import type * as ProcessUsage from '@kilocode/web-shared/lib/ai-gateway/processUsage';

const SECRET = 'benchmark-terminal-receipt-secret';
const ROUTER_ID = '6f1c2f3a-1111-4a2b-8c3d-4e5f60718293';
const PROJECT = benchmarkProjectId({ scope: 'user', slug: 'paid-pool', routerId: ROUTER_ID });

let benchmarkTerminalNoChargeStatus: typeof ProxyModule.benchmarkTerminalNoChargeStatus;
let handleBenchmarkUsageReceipts: typeof ReceiptRoute.handleBenchmarkUsageReceipts;
let recordTerminalNoChargeReceipt: typeof TerminalReceipt.recordTerminalNoChargeReceipt;
let insertUsageRecord: typeof ProcessUsage.insertUsageRecord;
let fetchUpstream: typeof UpstreamRequest.fetchUpstream;

beforeAll(async () => {
  jest.resetModules();
  ({ benchmarkTerminalNoChargeStatus } = await import('./llm-proxy'));
  ({ handleBenchmarkUsageReceipts } = await import('./benchmark-usage-receipts'));
  ({ recordTerminalNoChargeReceipt } =
    await import('@kilocode/web-shared/lib/ai-gateway/terminal-no-charge-receipt'));
  ({ insertUsageRecord } = await import('@kilocode/web-shared/lib/ai-gateway/processUsage'));
  ({ fetchUpstream } =
    await import('@kilocode/web-shared/lib/ai-gateway/providers/upstream-request'));
});

const benchmark = {
  assignment: {} as never,
  state: { admitted: true },
};

function errorAttempt(status: number, notInvoked: boolean) {
  return {
    type: 'error' as const,
    response: NextResponse.json({ error: 'refused' }, { status }),
    ...(notInvoked ? { notInvoked: true as const } : {}),
  };
}

/**
 * The gateway writes a terminal zero-charge receipt only where it can prove the provider was
 * never dialled. Anything that reached the network stays `pending`.
 */
describe('benchmark terminal no-charge decision', () => {
  it('answers 404 for a model the gateway never serves', () => {
    expect(benchmarkTerminalNoChargeStatus(benchmark, { type: 'unknown-gateway-model' })).toBe(404);
  });

  it('answers the refusal status when the provider layer proved nothing was dialled', () => {
    expect(benchmarkTerminalNoChargeStatus(benchmark, errorAttempt(503, true))).toBe(503);
    expect(benchmarkTerminalNoChargeStatus(benchmark, errorAttempt(402, true))).toBe(402);
  });

  it('answers null for an error whose reach is unknown, so it stays pending', () => {
    expect(benchmarkTerminalNoChargeStatus(benchmark, errorAttempt(503, false))).toBeNull();
    expect(benchmarkTerminalNoChargeStatus(benchmark, errorAttempt(499, false))).toBeNull();
  });

  it('answers null for an accepted call and for ordinary traffic', () => {
    const served = {
      type: 'success' as const,
      response: new Response('ok'),
      toolsAvailable: [],
      toolsUsed: [],
    };
    expect(benchmarkTerminalNoChargeStatus(benchmark, served)).toBeNull();
    expect(
      benchmarkTerminalNoChargeStatus(undefined, { type: 'unknown-gateway-model' })
    ).toBeNull();
    expect(benchmarkTerminalNoChargeStatus(undefined, errorAttempt(503, true))).toBeNull();
  });
});

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    type: 'openrouter',
    apiUrl: 'https://provider.invalid',
    apiKey: 'synthetic-key',
    apiKeyHeader: 'authorization',
    apiUrlOverrides: {},
    disableUrlSuffix: false,
    ...overrides,
  } as Provider;
}

/**
 * The provider layer's own proof. `notInvoked` must mean "no connection was opened", so a real
 * fetch call that throws is never marked, and only the two pre-connection refusals are.
 */
describe('provider layer marks only provable no-dial outcomes', () => {
  it('marks an already-aborted signal without calling fetch', async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await fetchUpstream({
        provider: provider(),
        method: 'POST',
        body: { model: 'openai/gpt-4o' },
        signal: controller.signal,
        path: '/chat/completions',
        durationBudgetMs: 1_000,
      });
      expect(result.type).toBe('error');
      expect(result.type === 'error' && result.notInvoked).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('never marks a fetch that was actually invoked and threw', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Object.assign(new Error('socket hang up'), { name: 'Error' }));
    try {
      const result = await fetchUpstream({
        provider: provider(),
        method: 'POST',
        body: { model: 'openai/gpt-4o' },
        path: '/chat/completions',
        durationBudgetMs: 1_000,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.type).toBe('error');
      expect(result.type === 'error' && result.notInvoked).toBeUndefined();
      expect(result.type === 'error' && result.fetchFailure).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
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
  createdAt: string | null;
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

/**
 * End to end: the decided status reaches the real native writer, and the real receipt read
 * reports exactly `microdollars: 0` for it, while an unknown-reach call writes nothing.
 */
describe('a proved no-dial refusal records an exact zero receipt', () => {
  it('writes cost 0 under the signed usage id and reads back recorded', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 1_000_000,
    });
    const usageId = '88888888-aaaa-4888-8888-888888888888';
    const status = benchmarkTerminalNoChargeStatus(benchmark, errorAttempt(503, true));
    expect(status).toBe(503);

    const deferred: Promise<void>[] = [];
    const write: TerminalReceipt.BenchmarkReceiptWriter = async (stats, context) => {
      const id = context.usageId;
      if (!id) throw new Error('receipt write needs the signed usage id');
      const usage = await defineMicrodollarUsage();
      return insertUsageRecord(
        {
          ...usage.core,
          id,
          kilo_user_id: user.id,
          cost: stats.cost_mUsd,
          model: stats.model ?? 'openai/gpt-4o',
          requested_model: context.requested_model,
          project_id: context.project_id,
        },
        { ...usage.metadata, id }
      );
    };

    if (status !== null) {
      recordTerminalNoChargeReceipt(benchmarkContext(user.id, usageId), status, write, task => {
        deferred.push(task());
      });
    }
    await Promise.all(deferred);

    const [receipt] = await readReceipts([usageId]);
    expect(receipt).toMatchObject({ usageId, status: 'recorded', microdollars: 0 });

    const rows = await db
      .select()
      .from(microdollar_usage)
      .where(eq(microdollar_usage.kilo_user_id, user.id));
    expect(rows.map(row => [row.id, row.cost])).toEqual([[usageId, 0]]);
  });

  it('writes nothing for an error whose reach is unknown', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 1_000_000,
    });
    const usageId = '99999999-bbbb-4999-8999-999999999999';
    expect(benchmarkTerminalNoChargeStatus(benchmark, errorAttempt(503, false))).toBeNull();

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
    const rows = await db
      .select()
      .from(microdollar_usage)
      .where(eq(microdollar_usage.kilo_user_id, user.id));
    expect(rows).toEqual([]);
  });
});

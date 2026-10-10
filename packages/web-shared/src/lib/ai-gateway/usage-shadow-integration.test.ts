import type * as ServerConfig from '@kilocode/web-shared/lib/config.server';
import type * as UsagePublisher from './usage-publisher';
import type * as UsageProcessing from './processUsage';
import type * as NextServer from 'next/server';
import type * as NextUnit from 'next/dist/server/app-render/work-unit-async-storage.external';
import type * as NextWork from 'next/dist/server/app-render/work-async-storage.external';
import type * as NextAfter from 'next/dist/server/after/after-context';
import { beforeEach, afterEach, describe, expect, test } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { MicrodollarUsageContext, MicrodollarUsageStats } from './processUsage.types';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  isUSRegion: () => process.env.VERCEL_REGION === 'sfo1',
  db: {
    transaction: jest.fn(),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    query: { microdollar_usage: { findFirst: jest.fn() } },
  },
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  USAGE_SHADOW_PUBLISH_ENABLED: false,
  USAGE_INGEST_URL: 'http://usage.example.test/usage',
  USAGE_INGEST_PUBLISH_SECRET: 'synthetic-local-secret',
}));
jest.mock('./usage-publisher', () => {
  const actual = jest.requireActual<typeof UsagePublisher>('./usage-publisher');
  return { ...actual, enqueueUsage: jest.fn(actual.enqueueUsage) };
});
jest.mock('./usage-record-client', () => ({ recordUsageInPrimaryRegion: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  startSpan: (_options: unknown, work: () => unknown) => work(),
  startInactiveSpan: () => ({ end() {}, setAttribute() {} }),
}));
jest.mock('@kilocode/web-shared/lib/posthog', () => ({
  __esModule: true,
  default: () => ({ capture() {} }),
}));
jest.mock('@kilocode/web-shared/lib/admin-utils-serverside', () => ({}));
jest.mock('@kilocode/web-shared/lib/getRootSpan', () => ({ sentryRootSpan: () => undefined }));
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => ({}));
jest.mock('@kilocode/web-shared/lib/kilo-pass/usage-triggered-bonus', () => ({}));
jest.mock('@kilocode/web-shared/lib/kilo-pass/threshold', () => ({
  getEffectiveKiloPassThreshold: () => null,
}));
jest.mock('@kilocode/web-shared/lib/kilo-pass/issuance', () => ({}));
jest.mock('./usage-daily-rollup-repairs', () => ({ enqueueDailyUsageRollupRepair: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/kilo-pass-org/consumption', () => ({}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  sentryLogger: () => () => {},
  logExceptInTest: () => {},
}));
jest.mock('./providers/upstream-request', () => ({ fetchGeneration: jest.fn() }));
jest.mock('./kilo-exclusive-models', () => ({
  findKiloExclusiveModel: () => undefined,
  shouldRedactModelNameInMicrodollarUsage: () => false,
}));
jest.mock('./is-free-model', () => ({ isFreeModel: (model: string) => model.endsWith(':free') }));
jest.mock('./custom-pricing', () => ({ calculateCustomCost_mUsd: () => undefined }));
jest.mock('@kilocode/web-shared/lib/bouncer/client', () => ({
  normalizeJa4: () => null,
  usageEventWireBody: (event: unknown) => event,
  reportUsageEvent: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/bouncer/dispatch-usage-event-outbox', () => ({
  deliverBouncerUsageEventNow: jest.fn(async () => true),
}));
jest.mock('@kilocode/db/bouncer-usage-event-outbox', () => ({
  enqueueBouncerUsageEvent: jest.fn(),
}));

// Next's installed runtime uses this global when constructing request async stores.
globalThis.AsyncLocalStorage = AsyncLocalStorage;
// The regular web setup may have imported Next before this runtime global was available.
jest.resetModules();
const { AfterContext } = jest.requireActual<typeof NextAfter>(
  'next/dist/server/after/after-context'
);
const { workAsyncStorage } = jest.requireActual<typeof NextWork>(
  'next/dist/server/app-render/work-async-storage.external'
);
const { workUnitAsyncStorage } = jest.requireActual<typeof NextUnit>(
  'next/dist/server/app-render/work-unit-async-storage.external'
);
const { after } = jest.requireActual<typeof NextServer>('next/server');
const {
  logMicrodollarUsage,
  logMicrodollarUsageAndReportToBouncer,
  processTokenData,
  saveUsageRelatedDataLocally,
} = jest.requireActual<typeof UsageProcessing>('./processUsage');
const publisher = jest.requireMock<typeof UsagePublisher>('./usage-publisher');
const config = jest.requireMock<{
  USAGE_SHADOW_PUBLISH_ENABLED: boolean;
  USAGE_INGEST_URL: string;
  USAGE_INGEST_PUBLISH_SECRET: string;
}>('@kilocode/web-shared/lib/config.server');
const { db } = jest.requireMock<{
  db: { transaction: jest.Mock; query: { microdollar_usage: { findFirst: jest.Mock } } };
}>('@kilocode/web-shared/lib/drizzle');
const writer = jest.requireMock<{ recordUsageInPrimaryRegion: jest.Mock }>(
  './usage-record-client'
).recordUsageInPrimaryRegion;
const bouncer = jest.requireMock<{ deliverBouncerUsageEventNow: jest.Mock }>(
  '@kilocode/web-shared/lib/bouncer/dispatch-usage-event-outbox'
);
const outbox = jest.requireMock<{ enqueueBouncerUsageEvent: jest.Mock }>(
  '@kilocode/db/bouncer-usage-event-outbox'
);

const stats: MicrodollarUsageStats = {
  messageId: 'synthetic-message',
  model: 'synthetic-model',
  responseContent: '',
  hasError: false,
  inference_provider: 'synthetic',
  upstream_id: null,
  finish_reason: 'stop',
  latency: null,
  moderation_latency: null,
  generation_time: null,
  streamed: false,
  cancelled: false,
  status_code: 200,
  cost_mUsd: 1234,
  inputTokens: 10,
  outputTokens: 20,
  cacheWriteTokens: 2,
  cacheHitTokens: 3,
  is_byok: false,
};
const context: MicrodollarUsageContext = {
  api_kind: 'chat_completions',
  kiloUserId: 'oauth/synthetic',
  provider: 'openrouter',
  requested_model: 'synthetic-model',
  fraudHeaders: {
    http_x_forwarded_for: null,
    http_x_vercel_ip_city: null,
    http_x_vercel_ip_country: null,
    http_x_vercel_ip_latitude: null,
    http_x_vercel_ip_longitude: null,
    http_x_vercel_ja4_digest: null,
    http_user_agent: null,
  },
  promptInfo: {
    system_prompt_prefix: 'synthetic-system',
    system_prompt_length: 16,
    user_prompt_prefix: 'synthetic-prompt',
  },
  max_tokens: null,
  has_middle_out_transform: null,
  isStreaming: false,
  prior_microdollar_usage: 100,
  posthog_distinct_id: 'synthetic-distinct',
  project_id: null,
  status_code: 200,
  editor_name: null,
  machine_id: null,
  user_byok: false,
  has_tools: false,
  feature: null,
  session_id: null,
  mode: null,
  auto_model: null,
  ttfb_ms: null,
  reasoning_setting: 'medium',
};
let sent: UsageRecordRequest[];
let queries: { sql: string; params: unknown[] }[];
let info: jest.SpiedFunction<typeof console.info>;
let warn: jest.SpiedFunction<typeof console.warn>;

function requestLifetime(waitUntilAvailable = true) {
  const pending: Promise<unknown>[] = [];
  const closeCallbacks: (() => void)[] = [];
  const errors: unknown[] = [];
  const afterContext = new AfterContext({
    waitUntil: waitUntilAvailable
      ? promise => {
          pending.push(promise);
        }
      : undefined,
    onClose: callback => {
      closeCallbacks.push(callback);
    },
    onTaskError: error => {
      errors.push(error);
    },
  });
  // Only the lifecycle and revalidation fields are used by AfterContext; no HTTP server is simulated here.
  const store = { afterContext } as Parameters<typeof workAsyncStorage.run>[0];
  const unit = { type: 'request', phase: 'action' } as Parameters<
    typeof workUnitAsyncStorage.run
  >[0];
  return {
    run: <T>(work: () => T): T =>
      workAsyncStorage.run(store, () => workUnitAsyncStorage.run(unit, work)),
    close: () => {
      closeCallbacks.forEach(callback => callback());
    },
    drain: async () => {
      for (let i = 0; i < pending.length; i++) await pending[i];
    },
    pending,
    errors,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(publisher.enqueueUsage)
    .mockImplementation(
      jest.requireActual<typeof UsagePublisher>('./usage-publisher').enqueueUsage
    );
  config.USAGE_SHADOW_PUBLISH_ENABLED = true;
  config.USAGE_INGEST_URL = 'http://usage.example.test/usage';
  config.USAGE_INGEST_PUBLISH_SECRET = 'synthetic-local-secret';
  process.env.VERCEL_REGION = 'fra1';
  sent = [];
  queries = [];
  info = jest.spyOn(console, 'info').mockImplementation(() => {});
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)) as UsageRecordRequest);
    return new Response(null, { status: 202 });
  });
  db.transaction.mockImplementation(
    async (work: (tx: { execute: (query: SQL) => Promise<unknown> }) => Promise<unknown>) =>
      work({
        execute: async query => {
          const compiled = new PgDialect().sqlToQuery(query);
          queries.push(compiled);
          return {
            rows: [
              {
                usage_id: compiled.params[0],
                usage_created_at: '2026-04-29 01:16:12.945+00',
                new_microdollars_used: 1334,
                kilo_pass_threshold: null,
              },
            ],
          };
        },
      })
  );
  writer.mockImplementation(async (payload: UsageRecordRequest) => ({
    kind: 'ok',
    result: {
      usageId: payload.core.id,
      createdAt: 'db-shaped timestamp',
      newMicrodollarsUsed: null,
    },
  }));
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.VERCEL_REGION;
});

describe('gateway shadow background integration', () => {
  test.each([undefined, '', 'false', 'TRUE', '1', 'true'])(
    'server switch enables only exact true (%s)',
    value => {
      const previous = process.env.USAGE_SHADOW_PUBLISH_ENABLED;
      const previousKey = process.env.BYOK_ENCRYPTION_KEY;
      try {
        if (value === undefined) delete process.env.USAGE_SHADOW_PUBLISH_ENABLED;
        else process.env.USAGE_SHADOW_PUBLISH_ENABLED = value;
        process.env.BYOK_ENCRYPTION_KEY = 'synthetic-key';
        jest.isolateModules(() => {
          const actual = jest.requireActual<typeof ServerConfig>(
            '@kilocode/web-shared/lib/config.server'
          );
          expect(actual.USAGE_SHADOW_PUBLISH_ENABLED).toBe(value === 'true');
        });
      } finally {
        if (previous === undefined) delete process.env.USAGE_SHADOW_PUBLISH_ENABLED;
        else process.env.USAGE_SHADOW_PUBLISH_ENABLED = previous;
        if (previousKey === undefined) delete process.env.BYOK_ENCRYPTION_KEY;
        else process.env.BYOK_ENCRYPTION_KEY = previousKey;
      }
    }
  );

  test('default off does not register publication or call the helper even with configured transport', async () => {
    config.USAGE_SHADOW_PUBLISH_ENABLED = false;
    const helper = jest.mocked(publisher.enqueueUsage);
    const lifecycle = requestLifetime();
    expect(
      await lifecycle.run(() => logMicrodollarUsage({ ...stats }, { ...context }))
    ).not.toBeNull();
    lifecycle.close();
    await lifecycle.drain();
    expect(lifecycle.pending).toHaveLength(0);
    expect(helper).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(['no_scope', 'no_wait_until'])(
    '%s cannot fail billing or start an untracked publication',
    async missing => {
      const work = () => logMicrodollarUsage({ ...stats }, { ...context });
      const result = await (missing === 'no_scope' ? work() : requestLifetime(false).run(work));
      expect(result).not.toBeNull();
      expect(publisher.enqueueUsage).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(warn).toHaveBeenCalledWith('usage enqueue unavailable', {
        usageId: result?.usageId,
        kind: 'unavailable',
        reason: 'registration_failed',
      });
    }
  );

  test.each(['fra1', 'sfo1'])(
    '%s sends the exact finalized event once, with one ID and complete bouncer data',
    async region => {
      process.env.VERCEL_REGION = region;
      const lifecycle = requestLifetime();
      const event = { request_id: 'synthetic-request', payload: { cost: 0 } };
      const record = await lifecycle.run(() =>
        logMicrodollarUsage(
          { ...stats, cost_mUsd: 0, market_cost: 1234 },
          { ...context, user_byok: true, organizationId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
          event
        )
      );
      expect(sent).toHaveLength(1);
      lifecycle.close();
      await lifecycle.drain();
      expect(sent).toHaveLength(1);
      const payload = sent[0];
      expect(payload.core.id).toBe(record?.usageId);
      expect(payload.metadata.id).toBe(record?.usageId);
      expect(payload.core.created_at).toBe(record?.createdAt);
      expect(payload.metadata.created_at).toBe(record?.createdAt);
      expect(payload).toMatchObject({
        core: {
          cost: 0,
          kilo_user_id: 'oauth/synthetic',
          organization_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        },
        metadata: {
          is_user_byok: true,
          reasoning_setting: 'medium',
          market_cost: 1234,
          user_prompt_prefix: null,
          system_prompt_prefix: null,
        },
        prior_microdollar_usage: 100,
        posthog_distinct_id: 'synthetic-distinct',
        bouncer_usage_event: event,
      });
      if (region === 'sfo1') {
        expect(writer).toHaveBeenCalledTimes(1);
        expect(writer).toHaveBeenCalledWith(payload);
        expect(db.transaction).not.toHaveBeenCalled();
      } else {
        expect(writer).not.toHaveBeenCalled();
        expect(db.transaction).toHaveBeenCalledTimes(1);
        const insert = queries.find(query => query.sql.includes('WITH microdollar_usage_ins'));
        expect(insert?.params.slice(0, 17)).toEqual([
          payload.core.id,
          payload.core.kilo_user_id,
          payload.core.organization_id,
          payload.core.provider,
          payload.core.cost,
          payload.core.input_tokens,
          payload.core.output_tokens,
          payload.core.cache_write_tokens,
          payload.core.cache_hit_tokens,
          payload.core.created_at,
          payload.core.model,
          payload.core.requested_model,
          payload.core.cache_discount,
          payload.core.has_error,
          payload.core.abuse_classification,
          payload.core.inference_provider,
          payload.core.project_id,
        ]);
        expect(outbox.enqueueBouncerUsageEvent).toHaveBeenCalledWith(expect.anything(), {
          requestId: event.request_id,
          userId: context.kiloUserId,
          payload: event.payload,
        });
      }
      expect(info).toHaveBeenCalledWith('usage enqueue accepted', {
        usageId: record?.usageId,
      });
      expect(warn).not.toHaveBeenCalled();
      expect(lifecycle.errors).toEqual([]);
    }
  );

  test.each(['promise', 'function'])(
    'actual Next after tracks nested publication from an outer %s without delaying billing/followups',
    async mode => {
      const lifecycle = requestLifetime();
      let accept: (response: Response) => void = () => {};
      const accepted = new Promise<Response>(resolve => {
        accept = resolve;
      });
      jest.mocked(fetch).mockReturnValue(accepted);
      const helper = jest.mocked(publisher.enqueueUsage);
      let billed = false;
      const work = async () => {
        await logMicrodollarUsageAndReportToBouncer(
          { ...stats },
          {
            ...context,
            bouncer: {
              requestId: 'synthetic-request',
              occurredAt: new Date(),
              accountId: 'user:synthetic',
              spendWatch: true,
              clientAttributed: false,
              requestedLogprobs: false,
              samples: 1,
              promptSimHash: null,
            },
          }
        );
        billed = true;
      };
      lifecycle.run(() => {
        after(mode === 'promise' ? work() : work);
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(billed).toBe(mode === 'promise');
      expect(helper).toHaveBeenCalledTimes(mode === 'promise' ? 1 : 0);
      // The response can close while both background tasks are pending.
      lifecycle.close();
      await new Promise(resolve => setImmediate(resolve));
      expect(billed).toBe(true);
      expect(bouncer.deliverBouncerUsageEventNow).toHaveBeenCalledTimes(1);
      expect(helper).toHaveBeenCalledTimes(1);
      expect(info).not.toHaveBeenCalled();
      let drained = false;
      const drain = lifecycle.drain().then(() => {
        drained = true;
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(drained).toBe(false);
      accept(new Response(null, { status: 202 }));
      await drain;
      expect(drained).toBe(true);
      expect(info).toHaveBeenCalledTimes(1);
      expect(lifecycle.errors).toEqual([]);
    }
  );

  test.each(['fra1', 'sfo1'])(
    '%s tracks late eager accounting after the earlier cleanup callback has drained',
    async region => {
      process.env.VERCEL_REGION = region;
      const lifecycle = requestLifetime();
      const generation = Promise.withResolvers<void>();
      const billed = Promise.withResolvers<void>();
      const acceptance = Promise.withResolvers<Response>();
      jest.mocked(fetch).mockReturnValue(acceptance.promise);
      let cleanedUp = false;
      lifecycle.run(() => {
        // upstreamRequest registers cleanup before eager accountForMicrodollarUsage.
        after(() => {
          cleanedUp = true;
        });
        after(
          (async () => {
            // Stream parsing/generation lookup can finish after response cleanup.
            await generation.promise;
            await processTokenData({ ...stats }, { ...context });
            billed.resolve();
          })()
        );
      });
      lifecycle.close();
      await lifecycle.pending[0]; // The function callback queue is now completely idle.
      expect(cleanedUp).toBe(true);
      expect(publisher.enqueueUsage).not.toHaveBeenCalled();
      generation.resolve();
      await billed.promise;
      expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
      expect(info).not.toHaveBeenCalled();
      let drained = false;
      const drain = lifecycle.drain().then(() => {
        drained = true;
      });
      await new Promise(resolve => setImmediate(resolve));
      const drainedBeforeAcceptance = drained;
      // Release the network even when the regression fails, so the test leaks no work.
      acceptance.resolve(new Response(null, { status: 202 }));
      await drain;
      await new Promise(resolve => setImmediate(resolve));
      expect(drainedBeforeAcceptance).toBe(false);
      expect(info).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      expect(lifecycle.errors).toEqual([]);
    }
  );

  test.each(['http401', 'http503', 'network', 'unexpected', 'invalid_url', 'missing_config'])(
    '%s does not change successful or null billing and logs only safe categories',
    async failure => {
      process.env.VERCEL_REGION = 'sfo1';
      if (failure === 'unexpected')
        jest.mocked(publisher.enqueueUsage).mockRejectedValue(new Error('sensitive-secret-prompt'));
      else if (failure === 'network')
        jest.mocked(fetch).mockRejectedValue(new Error('sensitive-secret-prompt'));
      else if (failure === 'invalid_url') config.USAGE_INGEST_URL = 'secret-invalid';
      else if (failure === 'missing_config') config.USAGE_INGEST_PUBLISH_SECRET = '';
      else
        jest
          .mocked(fetch)
          .mockResolvedValue(
            new Response('sensitive-secret-prompt', { status: failure === 'http401' ? 401 : 503 })
          );
      for (const result of ['success', 'null']) {
        if (result === 'null') {
          process.env.VERCEL_REGION = 'fra1';
          db.transaction.mockRejectedValue({ code: '23505', constraint: 'microdollar_usage_pkey' });
          jest.spyOn(console, 'error').mockImplementation(() => {});
        }
        const lifecycle = requestLifetime();
        const record = await lifecycle.run(() => logMicrodollarUsage({ ...stats }, { ...context }));
        expect(record === null).toBe(result === 'null');
        lifecycle.close();
        await lifecycle.drain();
        expect(lifecycle.errors).toEqual([]);
      }
      expect(info).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(failure === 'missing_config' ? 0 : 2);
      if (failure !== 'missing_config') {
        const reason =
          failure === 'unexpected'
            ? 'unexpected_rejection'
            : failure === 'http401'
              ? 'http_401'
              : failure === 'http503'
                ? 'http_503'
                : 'request_failed';
        expect(warn).toHaveBeenLastCalledWith('usage enqueue unavailable', {
          usageId: expect.any(String),
          kind: 'unavailable',
          reason,
        });
      }
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive-secret-prompt');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-invalid');
    }
  );

  test('SFO fallback and the local writer endpoint never create a second publication', async () => {
    process.env.VERCEL_REGION = 'sfo1';
    writer.mockResolvedValue({ kind: 'unavailable' });
    const lifecycle = requestLifetime();
    const record = await lifecycle.run(() =>
      logMicrodollarUsage({ ...stats }, { ...context, posthog_distinct_id: undefined })
    );
    lifecycle.close();
    await lifecycle.drain();
    expect(sent).toHaveLength(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const payload = sent[0];
    expect(payload.core.id).toBe(record?.usageId);
    const endpoint = requestLifetime();
    await endpoint.run(() =>
      saveUsageRelatedDataLocally(
        payload.core,
        payload.metadata,
        payload.prior_microdollar_usage,
        null,
        payload.bouncer_usage_event
      )
    );
    endpoint.close();
    await endpoint.drain();
    expect(sent).toHaveLength(1);
    expect(endpoint.pending).toHaveLength(0);
  });

  test.each([false, true])(
    'processTokenData preserves final free/BYOK costs (BYOK=%s)',
    async byok => {
      process.env.VERCEL_REGION = 'sfo1';
      const lifecycle = requestLifetime();
      const ctx = {
        ...context,
        user_byok: byok,
        requested_model: byok ? 'synthetic-model' : 'synthetic-model:free',
      };
      const record = await lifecycle.run(() => processTokenData({ ...stats }, ctx));
      lifecycle.close();
      await lifecycle.drain();
      expect(sent).toHaveLength(1);
      expect(sent[0].core.id).toBe(record?.usageId);
      expect(sent[0].core.cost).toBe(0);
      expect(sent[0].core.cache_discount).toBe(0);
      expect(sent[0].metadata.market_cost).toBe(1234);
      expect(writer).toHaveBeenCalledWith(sent[0]);
    }
  );
});

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
  USAGE_QUEUE_ONLY_ENABLED: false,
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
  USAGE_QUEUE_ONLY_ENABLED: boolean;
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
const { fetchGeneration } = jest.requireMock<{ fetchGeneration: jest.Mock }>(
  './providers/upstream-request'
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
  is_free: false,
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
let info: jest.MockedFunction<typeof console.info>;
let completionLogs: string[];
let warn: jest.MockedFunction<typeof console.warn>;
let error: jest.MockedFunction<typeof console.error>;

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
  config.USAGE_QUEUE_ONLY_ENABLED = false;
  bouncer.deliverBouncerUsageEventNow.mockResolvedValue(true);
  config.USAGE_INGEST_URL = 'http://usage.example.test/usage';
  config.USAGE_INGEST_PUBLISH_SECRET = 'synthetic-local-secret';
  process.env.VERCEL_REGION = 'fra1';
  sent = [];
  queries = [];
  info = jest.fn();
  completionLogs = [];
  jest.spyOn(console, 'info').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('"event":"usage_record_completion"')) {
      completionLogs.push(args[0]);
    } else info(...args);
  });
  error = jest.fn();
  jest.spyOn(console, 'error').mockImplementation((...args) => error(...args));
  warn = jest.fn();
  jest.spyOn(console, 'warn').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('"event":"usage_record_completion"')) {
      completionLogs.push(args[0]);
    } else warn(...args);
  });
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
        payload.bouncer_usage_event,
        { entrypoint: 'writer_endpoint', writer_caller: 'queue' }
      )
    );
    endpoint.close();
    await endpoint.drain();
    expect(sent).toHaveLength(1);
    expect(endpoint.pending).toHaveLength(0);
    expect(completionLogs.map(value => JSON.parse(value))).toEqual(
      [
        { entrypoint: 'gateway', writer_caller: 'unknown' },
        { entrypoint: 'writer_endpoint', writer_caller: 'queue' },
      ].map(context => ({
        level: 'info',
        event: 'usage_record_completion',
        sample_rate: 1,
        usage_id: payload.core.id,
        outcome: 'recorded',
        duration_ms: expect.any(Number),
        event_age_ms: expect.any(Number),
        execution_region: 'sfo1',
        ...context,
      }))
    );
  });

  test('Frankfurt direct writes emit the shared completion without publishing', async () => {
    config.USAGE_SHADOW_PUBLISH_ENABLED = false;
    const record = await logMicrodollarUsage({ ...stats }, { ...context });
    expect(record).not.toBeNull();
    expect(writer).not.toHaveBeenCalled();
    expect(publisher.enqueueUsage).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(completionLogs).toHaveLength(1);
    expect(JSON.parse(completionLogs[0])).toEqual({
      level: 'info',
      event: 'usage_record_completion',
      sample_rate: 1,
      usage_id: record?.usageId,
      outcome: 'recorded',
      duration_ms: expect.any(Number),
      event_age_ms: expect.any(Number),
      execution_region: 'fra1',
      entrypoint: 'gateway',
      writer_caller: 'unknown',
    });
  });

  test.each([false, true])(
    'processTokenData preserves final free/BYOK costs (BYOK=%s)',
    async byok => {
      process.env.VERCEL_REGION = 'sfo1';
      const lifecycle = requestLifetime();
      const ctx = {
        ...context,
        user_byok: byok,
        is_free: !byok,
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
      expect(sent[0].metadata.is_free).toBe(!byok);
      expect(writer).toHaveBeenCalledWith(sent[0]);
    }
  );

  test.each([
    { generationFinishReason: null, expected: 'refusal' },
    { generationFinishReason: 'content_filter', expected: 'content_filter' },
  ])(
    'processTokenData keeps the response finish_reason only when the generation lookup has none ($generationFinishReason)',
    async ({ generationFinishReason, expected }) => {
      process.env.VERCEL_REGION = 'sfo1';
      fetchGeneration.mockResolvedValue({
        data: {
          id: 'synthetic-message',
          total_cost: 0.001,
          created_at: '2026-10-16T00:00:00.000Z',
          model: 'synthetic-model',
          origin: '',
          usage: 0.001,
          is_byok: false,
          provider_name: 'synthetic',
          finish_reason: generationFinishReason,
          native_tokens_prompt: 10,
          native_tokens_completion: 0,
        },
      });
      const lifecycle = requestLifetime();
      await lifecycle.run(() =>
        processTokenData({ ...stats, outputTokens: 0, finish_reason: 'refusal' }, context)
      );
      lifecycle.close();
      await lifecycle.drain();
      expect(fetchGeneration).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(1);
      expect(sent[0].metadata.finish_reason).toBe(expected);
    }
  );
});

describe('queued usage accounting', () => {
  test.each([
    [undefined, 'staging', 'preview', false],
    ['false', 'staging', 'preview', false],
    ['TRUE', 'staging', 'preview', false],
    ['1', 'staging', 'preview', false],
    ['true', undefined, undefined, false],
    ['true', 'preview', 'preview', false],
    ['true', 'production', 'production', false],
    ['true', 'production', undefined, false],
    ['true', 'STAGING', 'preview', false],
    ['true', 'staging', 'production', false],
    ['true', 'staging', 'preview', true],
    ['true', 'staging', undefined, true],
  ])('server opt-in %s / target %s / Vercel %s enables=%s', (flag, target, vercel, enabled) => {
    const original = { ...process.env };
    try {
      for (const [key, value] of Object.entries({
        USAGE_QUEUE_ONLY_ENABLED: flag,
        VERCEL_TARGET_ENV: target,
        VERCEL_ENV: vercel,
        BYOK_ENCRYPTION_KEY: 'synthetic-key',
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = String(value);
      }
      jest.isolateModules(() => {
        const actual = jest.requireActual<typeof ServerConfig>(
          '@kilocode/web-shared/lib/config.server'
        );
        expect(actual.USAGE_QUEUE_ONLY_ENABLED).toBe(enabled);
      });
    } finally {
      process.env = original;
    }
  });

  test.each([
    { region: 'fra1', shadow: false },
    { region: 'fra1', shadow: true },
    { region: 'sfo1', shadow: false },
    { region: 'sfo1', shadow: true },
  ])(
    '$region confirmed acceptance queues once without a direct write (shadow=$shadow)',
    async ({ region, shadow }) => {
      config.USAGE_QUEUE_ONLY_ENABLED = true;
      config.USAGE_SHADOW_PUBLISH_ENABLED = shadow;
      process.env.VERCEL_REGION = region;
      const lifecycle = requestLifetime();
      const event = { request_id: 'synthetic-request', payload: { cost: 1234 } };
      const record = await lifecycle.run(() =>
        logMicrodollarUsage({ ...stats }, { ...context }, event)
      );
      lifecycle.close();
      await lifecycle.drain();
      expect(record).toEqual({
        status: 'queued',
        usageId: sent[0].core.id,
        createdAt: sent[0].core.created_at,
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        core: { id: record?.usageId, cost: stats.cost_mUsd },
        metadata: { id: record?.usageId, created_at: record?.createdAt },
        prior_microdollar_usage: context.prior_microdollar_usage,
        posthog_distinct_id: context.posthog_distinct_id,
        bouncer_usage_event: event,
      });
      expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
      expect(writer).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(outbox.enqueueBouncerUsageEvent).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith('usage accounting queued', { usageId: record?.usageId });
      expect(warn).not.toHaveBeenCalled();
      expect(lifecycle.errors).toEqual([]);
    }
  );

  test.each(
    ['fra1', 'sfo1'].flatMap(region =>
      ['promise', 'function', 'late'].flatMap(mode =>
        [202, 503].map(status => ({ region, mode, status }))
      )
    )
  )(
    'Next accounting lifetime awaits $region HTTP $status from $mode work',
    async ({ region, mode, status }) => {
      config.USAGE_QUEUE_ONLY_ENABLED = true;
      process.env.VERCEL_REGION = region;
      const lifecycle = requestLifetime();
      const acceptance = Promise.withResolvers<Response>();
      const generation = Promise.withResolvers<void>();
      jest.mocked(fetch).mockReturnValue(acceptance.promise);
      let result: Awaited<ReturnType<typeof processTokenData>> = null;
      const work = async () => {
        if (mode === 'late') await generation.promise;
        result = await processTokenData({ ...stats }, { ...context });
      };
      lifecycle.run(() => {
        if (mode === 'late') after(() => {});
        after(mode === 'function' ? work : work());
      });
      lifecycle.close();
      if (mode === 'late') await lifecycle.pending[0];
      generation.resolve();
      await new Promise(resolve => setImmediate(resolve));
      expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
      let drained = false;
      const drain = lifecycle.drain().then(() => {
        drained = true;
      });
      await new Promise(resolve => setImmediate(resolve));
      const drainedBeforeAcceptance = drained;
      acceptance.resolve(new Response(null, { status }));
      await drain;
      expect(drainedBeforeAcceptance).toBe(false);
      if (status === 202) {
        expect(result).toMatchObject({ status: 'queued' });
        expect(error).not.toHaveBeenCalled();
      } else {
        expect(result).toBeNull();
        expect(info).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith('usage accounting publication failed', {
          usageId: jest.mocked(publisher.enqueueUsage).mock.calls[0][0].core.id,
          reason: 'http_503',
        });
      }
      expect(db.transaction).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
      expect(lifecycle.errors).toEqual([]);
    }
  );

  test.each(['fra1', 'sfo1'])(
    '%s accounting lifetime includes retry backoff and the next publication',
    async region => {
      config.USAGE_QUEUE_ONLY_ENABLED = true;
      process.env.VERCEL_REGION = region;
      const secondAttempt = Promise.withResolvers<void>();
      const accepted = Promise.withResolvers<Response>();
      jest.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
      jest.mocked(fetch).mockImplementation(() => {
        secondAttempt.resolve();
        return accepted.promise;
      });
      const lifecycle = requestLifetime();
      let result: Awaited<ReturnType<typeof processTokenData>> = null;
      lifecycle.run(() =>
        after(async () => {
          result = await processTokenData({ ...stats }, { ...context });
        })
      );
      lifecycle.close();
      let drained = false;
      const drain = lifecycle.drain().then(() => {
        drained = true;
      });
      await secondAttempt.promise;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result).toBeNull();
      expect(drained).toBe(false);
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      accepted.resolve(new Response(null, { status: 202 }));
      await drain;
      expect(result).toMatchObject({ status: 'queued' });
      const payload = jest.mocked(publisher.enqueueUsage).mock.calls[0][0];
      expect(jest.mocked(fetch).mock.calls.map(([, init]) => init?.body)).toEqual([
        JSON.stringify(payload),
        JSON.stringify(payload),
      ]);
      expect(writer).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(outbox.enqueueBouncerUsageEvent).not.toHaveBeenCalled();
      expect(lifecycle.errors).toEqual([]);
    }
  );

  const callers = [
    { name: 'logMicrodollarUsage', run: logMicrodollarUsage, reportsUsage: false },
    { name: 'processTokenData', run: processTokenData, reportsUsage: true },
    {
      name: 'logMicrodollarUsageAndReportToBouncer',
      run: logMicrodollarUsageAndReportToBouncer,
      reportsUsage: true,
    },
  ];
  const failures = [
    'missing_url',
    'missing_secret',
    'http_401',
    'http_503',
    'timeout',
    'transport_failure',
    'unexpected_rejection',
  ];
  const report = jest.requireMock<{ reportUsageEvent: jest.Mock }>(
    '@kilocode/web-shared/lib/bouncer/client'
  ).reportUsageEvent;
  const watchedContext: MicrodollarUsageContext = {
    ...context,
    bouncer: {
      requestId: 'synthetic-request',
      occurredAt: new Date('2026-10-20T00:00:00.000Z'),
      accountId: 'user:synthetic',
      spendWatch: true,
      clientAttributed: false,
      requestedLogprobs: false,
      samples: 1,
      promptSimHash: null,
    },
  };

  describe.each(callers)('$name', ({ run, reportsUsage }) => {
    test.each(['fra1', 'sfo1'].flatMap(region => failures.map(failure => ({ region, failure }))))(
      '$region returns failed accounting without any direct write on $failure',
      async ({ region, failure }) => {
        config.USAGE_QUEUE_ONLY_ENABLED = true;
        process.env.VERCEL_REGION = region;
        fetchGeneration.mockResolvedValue(null);
        if (failure === 'timeout') {
          const nativeTimeout = AbortSignal.timeout;
          jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(5));
        }
        if (failure === 'missing_url') config.USAGE_INGEST_URL = '';
        else if (failure === 'missing_secret') config.USAGE_INGEST_PUBLISH_SECRET = '';
        else if (failure === 'unexpected_rejection')
          jest
            .mocked(publisher.enqueueUsage)
            .mockRejectedValue(new Error('sensitive-secret-prompt'));
        else
          jest.mocked(fetch).mockImplementation(async (_url, init) => {
            sent.push(JSON.parse(String(init?.body)) as UsageRecordRequest);
            if (failure === 'timeout') {
              await new Promise((_resolve, reject) =>
                init?.signal?.addEventListener(
                  'abort',
                  () => reject(new Error('sensitive-secret-prompt')),
                  { once: true }
                )
              );
            }
            if (failure === 'transport_failure') throw new Error('sensitive-secret-prompt');
            return new Response('sensitive-secret-prompt', {
              status: failure === 'http_401' ? 401 : 503,
            });
          });
        const lifecycle = requestLifetime();
        const record = await lifecycle.run(() => run({ ...stats }, { ...watchedContext }));
        lifecycle.close();
        await lifecycle.drain();
        const payload = jest.mocked(publisher.enqueueUsage).mock.calls[0][0];
        expect(record).toBeNull();
        expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
        expect(payload.core.id).toEqual(expect.any(String));
        expect(payload.metadata.id).toBe(payload.core.id);
        expect(payload.metadata.created_at).toBe(payload.core.created_at);
        expect(new Date(payload.core.created_at).toISOString()).toBe(payload.core.created_at);
        expect(payload.core.cost).toBe(stats.cost_mUsd);
        if (reportsUsage)
          expect(payload.bouncer_usage_event).toMatchObject({ request_id: 'synthetic-request' });
        const attemptedHttp = !failure.startsWith('missing') && failure !== 'unexpected_rejection';
        const attempts = attemptedHttp
          ? failure === 'http_401'
            ? 1
            : publisher.USAGE_ENQUEUE_MAX_ATTEMPTS
          : 0;
        expect(fetch).toHaveBeenCalledTimes(attempts);
        expect(sent).toEqual(
          Array.from({ length: attempts }, () => JSON.parse(JSON.stringify(payload)))
        );
        expect(publisher.enqueueUsage).toHaveBeenCalledWith(payload, {
          retryTransientFailures: true,
        });
        expect(writer).not.toHaveBeenCalled();
        expect(db.transaction).not.toHaveBeenCalled();
        expect(outbox.enqueueBouncerUsageEvent).not.toHaveBeenCalled();
        expect(bouncer.deliverBouncerUsageEventNow).not.toHaveBeenCalled();
        expect(report).toHaveBeenCalledTimes(reportsUsage ? 1 : 0);
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith('usage accounting publication failed', {
          usageId: payload.core.id,
          reason: failure.startsWith('missing')
            ? 'publisher_disabled'
            : failure === 'transport_failure'
              ? 'request_failed'
              : failure,
        });
        const logs = JSON.stringify([...error.mock.calls, ...warn.mock.calls, ...info.mock.calls]);
        for (const sensitive of [
          'sensitive-secret-prompt',
          'synthetic-local-secret',
          'synthetic-prompt',
          'synthetic-system',
        ]) {
          expect(logs).not.toContain(sensitive);
        }
        expect(info).not.toHaveBeenCalled();
        expect(completionLogs).toEqual([]);
        expect(lifecycle.errors).toEqual([]);
      }
    );

    test.each(
      ['fra1', 'sfo1'].flatMap(region =>
        ['no_scope', 'no_wait_until'].map(missing => ({ region, missing }))
      )
    )(
      '$region / $missing returns failure without untracked publication or direct billing',
      async ({ region, missing }) => {
        config.USAGE_QUEUE_ONLY_ENABLED = true;
        process.env.VERCEL_REGION = region;
        fetchGeneration.mockResolvedValue(null);
        const lifecycle = requestLifetime(false);
        const work = () => run({ ...stats }, { ...watchedContext });
        const record = await (missing === 'no_scope' ? work() : lifecycle.run(work));
        lifecycle.close();
        await lifecycle.drain();
        expect(record).toBeNull();
        expect(publisher.enqueueUsage).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
        expect(writer).not.toHaveBeenCalled();
        expect(db.transaction).not.toHaveBeenCalled();
        expect(outbox.enqueueBouncerUsageEvent).not.toHaveBeenCalled();
        expect(bouncer.deliverBouncerUsageEventNow).not.toHaveBeenCalled();
        expect(report).toHaveBeenCalledTimes(reportsUsage ? 1 : 0);
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith('usage accounting publication failed', {
          usageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          reason: 'registration_failed',
        });
        expect(warn).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
        expect(completionLogs).toEqual([]);
        expect(lifecycle.errors).toEqual([]);
      }
    );
  });

  test.each(
    ['fra1', 'sfo1'].flatMap(region =>
      [false, true].flatMap(spendWatch =>
        [202, 503].map(status => ({ region, spendWatch, status }))
      )
    )
  )(
    'Bouncer $region HTTP $status spendWatch=$spendWatch avoids gateway outbox delivery',
    async ({ region, spendWatch, status }) => {
      config.USAGE_QUEUE_ONLY_ENABLED = true;
      process.env.VERCEL_REGION = region;
      jest.mocked(fetch).mockImplementation(async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as UsageRecordRequest);
        return new Response(null, { status });
      });
      const report = jest.requireMock<{ reportUsageEvent: jest.Mock }>(
        '@kilocode/web-shared/lib/bouncer/client'
      ).reportUsageEvent;
      const lifecycle = requestLifetime();
      const record = await lifecycle.run(() =>
        logMicrodollarUsageAndReportToBouncer(
          { ...stats },
          {
            ...context,
            bouncer: {
              requestId: 'synthetic-request',
              occurredAt: new Date(),
              accountId: 'user:synthetic',
              spendWatch,
              clientAttributed: false,
              requestedLogprobs: false,
              samples: 1,
              promptSimHash: null,
            },
          }
        )
      );
      lifecycle.close();
      await lifecycle.drain();
      if (status === 202) expect(record?.status).toBe('queued');
      else {
        expect(record).toBeNull();
        expect(info).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith('usage accounting publication failed', {
          usageId: sent[0].core.id,
          reason: 'http_503',
        });
      }
      expect(bouncer.deliverBouncerUsageEventNow).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledTimes(status === 202 && spendWatch ? 0 : 1);
      expect(sent[0].bouncer_usage_event).toEqual(
        spendWatch ? expect.objectContaining({ request_id: 'synthetic-request' }) : null
      );
      expect(writer).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(outbox.enqueueBouncerUsageEvent).not.toHaveBeenCalled();
      expect(lifecycle.errors).toEqual([]);
    }
  );

  test.each(['fra1', 'sfo1'].flatMap(region => [false, true].map(shadow => ({ region, shadow }))))(
    'queue off keeps $region direct billing (shadow=$shadow)',
    async ({ region, shadow }) => {
      process.env.VERCEL_REGION = region;
      config.USAGE_QUEUE_ONLY_ENABLED = false;
      config.USAGE_SHADOW_PUBLISH_ENABLED = shadow;
      const lifecycle = requestLifetime();
      const record = await lifecycle.run(() => logMicrodollarUsage({ ...stats }, { ...context }));
      lifecycle.close();
      await lifecycle.drain();
      expect(record?.status).toBe('recorded');
      expect(publisher.enqueueUsage).toHaveBeenCalledTimes(shadow ? 1 : 0);
      expect(writer).toHaveBeenCalledTimes(region === 'sfo1' ? 1 : 0);
      expect(db.transaction).toHaveBeenCalledTimes(region === 'fra1' ? 1 : 0);
      expect(error).not.toHaveBeenCalled();
    }
  );

  test('queue off retains failed direct accounting and best-effort Bouncer reporting', async () => {
    config.USAGE_QUEUE_ONLY_ENABLED = false;
    config.USAGE_SHADOW_PUBLISH_ENABLED = false;
    process.env.VERCEL_REGION = 'sfo1';
    writer.mockResolvedValue({ kind: 'ok', result: null });
    const lifecycle = requestLifetime();
    const record = await lifecycle.run(() =>
      logMicrodollarUsageAndReportToBouncer({ ...stats }, { ...watchedContext })
    );
    lifecycle.close();
    await lifecycle.drain();
    expect(record).toBeNull();
    expect(publisher.enqueueUsage).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(bouncer.deliverBouncerUsageEventNow).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(lifecycle.errors).toEqual([]);
  });
});

test('unexpected post-commit Bouncer failure preserves recorded accounting and cron ownership', async () => {
  config.USAGE_SHADOW_PUBLISH_ENABLED = false;
  bouncer.deliverBouncerUsageEventNow.mockRejectedValue(new Error('sensitive-secret-prompt'));
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const report = jest.requireMock<{ reportUsageEvent: jest.Mock }>(
    '@kilocode/web-shared/lib/bouncer/client'
  ).reportUsageEvent;
  const lifecycle = requestLifetime();
  const record = await lifecycle.run(() =>
    logMicrodollarUsageAndReportToBouncer(
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
    )
  );
  lifecycle.close();
  await lifecycle.drain();
  expect(record?.status).toBe('recorded');
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(bouncer.deliverBouncerUsageEventNow).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith('post-commit bouncer usage delivery failed', {
    databaseErrorCode: null,
  });
  expect(JSON.stringify(error.mock.calls)).not.toContain('sensitive-secret-prompt');
  expect(lifecycle.errors).toEqual([]);
});

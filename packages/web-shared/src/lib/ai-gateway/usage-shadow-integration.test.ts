import type * as ServerConfig from '@kilocode/web-shared/lib/config.server';
import type * as UsagePublisher from './usage-publisher';
import type * as UsageProcessing from './processUsage';
import type * as NextServer from 'next/server';
import type * as NextUnit from 'next/dist/server/app-render/work-unit-async-storage.external';
import type * as NextWork from 'next/dist/server/app-render/work-async-storage.external';
import type * as NextAfter from 'next/dist/server/after/after-context';
import { beforeEach, afterEach, describe, expect, test } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { MicrodollarUsageContext, MicrodollarUsageStats } from './processUsage.types';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';
import type { UserForBalance } from '@kilocode/web-shared/lib/user/balance-types';
import type { UsageQueueFraConfig, UsageQueueSfoConfig } from './usage-queue-config';

const nativeFetch = globalThis.fetch;
const nativeDateNow = Date.now;
let publisherReportClockMs = 0;

/** Moves past the per-instance Sentry throttle so each test observes its own first report. */
function advancePublisherReportClock() {
  publisherReportClockMs += 60 * 60_000;
  const offset = publisherReportClockMs;
  jest.spyOn(Date, 'now').mockImplementation(() => nativeDateNow() + offset);
}

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  isUSRegion: () => process.env.VERCEL_REGION === 'sfo1',
  db: {
    transaction: jest.fn(),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    query: { microdollar_usage: { findFirst: jest.fn() } },
  },
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  USAGE_QUEUE_ONLY_ENABLED: false,
  USAGE_QUEUE_SFO_CONFIG: { enabled: false, exposure: 0, userIds: null },
  USAGE_QUEUE_FRA_CONFIG: { enabled: false, exposure: 0 },
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
  warnExceptInTest: () => {},
}));
jest.mock('./providers/upstream-request', () => ({ fetchGeneration: jest.fn() }));
jest.mock('./custom-pricing', () => ({ calculateCustomCost_mUsd: () => undefined }));
jest.mock('@kilocode/web-shared/lib/bouncer/client', () => ({
  normalizeJa4: () => null,
  usageEventWireBody: jest.fn((event: unknown) => event),
  reportUsageEvent: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/bouncer/dispatch-usage-event-outbox', () => ({
  deliverBouncerUsageEventNow: jest.fn(async () => true),
}));
jest.mock('@kilocode/db/bouncer-usage-event-outbox', () => ({
  enqueueBouncerUsageEvent: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/autoTopUp', () => ({
  maybePerformAutoTopUp: jest.fn(async () => {}),
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
  USAGE_QUEUE_ONLY_ENABLED: boolean;
  USAGE_QUEUE_SFO_CONFIG: UsageQueueSfoConfig;
  USAGE_QUEUE_FRA_CONFIG: UsageQueueFraConfig;
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
const autoTopUp = jest.requireMock<{ maybePerformAutoTopUp: jest.Mock }>(
  '@kilocode/web-shared/lib/autoTopUp'
);
const sentry = jest.requireMock<{ captureException: jest.Mock; captureMessage: jest.Mock }>(
  '@sentry/nextjs'
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
let info: jest.MockedFunction<typeof console.info>;
let completionLogs: string[];
let warn: jest.MockedFunction<typeof console.warn>;
let error: jest.MockedFunction<typeof console.error>;
let autoTopUpUser: UserForBalance | null;
const enabledAutoTopUpUser: UserForBalance = {
  id: 'oauth/synthetic',
  total_microdollars_acquired: 5_000_000,
  microdollars_used: 1334,
  next_credit_expiration_at: null,
  updated_at: '2026-04-29T01:16:12.945Z',
  auto_top_up_enabled: true,
};

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

  config.USAGE_QUEUE_ONLY_ENABLED = false;
  config.USAGE_QUEUE_SFO_CONFIG = { enabled: false, exposure: 0, userIds: null };
  config.USAGE_QUEUE_FRA_CONFIG = { enabled: false, exposure: 0 };
  bouncer.deliverBouncerUsageEventNow.mockResolvedValue(true);
  config.USAGE_INGEST_URL = 'http://usage.example.test/usage';
  config.USAGE_INGEST_PUBLISH_SECRET = 'synthetic-local-secret';
  process.env.VERCEL_REGION = 'fra1';
  sent = [];
  autoTopUpUser = null;
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
    sent.push(JSON.parse(init?.body as string) as UsageRecordRequest);
    return new Response(null, { status: 202 });
  });
  db.transaction.mockImplementation(
    async (work: (tx: { execute: (query: SQL) => Promise<unknown> }) => Promise<unknown>) =>
      work({
        execute: async query => {
          const compiled = new PgDialect().sqlToQuery(query);
          return {
            rows: [
              {
                usage_id: compiled.params[0],
                usage_created_at: '2026-04-29 01:16:12.945+00',
                new_microdollars_used: 1334,
                kilo_pass_threshold: null,
                auto_top_up_user: autoTopUpUser,
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

function configureQueueEnvironment(overrides: Record<string, string | undefined> = {}) {
  const original = { ...process.env };
  try {
    for (const [key, value] of Object.entries({
      USAGE_QUEUE_ONLY_ENABLED: 'true',
      USAGE_QUEUE_SFO_EXPOSURE: '1',
      USAGE_QUEUE_FRA_EXPOSURE: undefined,
      USAGE_QUEUE_SFO_USER_IDS: '',
      VERCEL_ENV: 'production',
      VERCEL_TARGET_ENV: 'production',
      VERCEL_REGION: 'sfo1',
      BYOK_ENCRYPTION_KEY: 'synthetic-key',
      ...overrides,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.isolateModules(() => {
      const actual = jest.requireActual<typeof ServerConfig>(
        '@kilocode/web-shared/lib/config.server'
      );
      config.USAGE_QUEUE_ONLY_ENABLED = actual.USAGE_QUEUE_ONLY_ENABLED;
      config.USAGE_QUEUE_SFO_CONFIG = actual.USAGE_QUEUE_SFO_CONFIG;
      config.USAGE_QUEUE_FRA_CONFIG = actual.USAGE_QUEUE_FRA_CONFIG;
    });
  } finally {
    process.env = original;
  }
  if ('VERCEL_REGION' in overrides && overrides.VERCEL_REGION === undefined) {
    delete process.env.VERCEL_REGION;
  } else {
    process.env.VERCEL_REGION = overrides.VERCEL_REGION ?? 'sfo1';
  }
}

const personalBouncer: NonNullable<MicrodollarUsageContext['bouncer']> = {
  requestId: 'synthetic-personal',
  occurredAt: new Date('2026-10-27T00:00:00.000Z'),
  accountId: `user:${context.kiloUserId}`,
  spendWatch: false,
  clientAttributed: false,
  requestedLogprobs: false,
  samples: 1,
  promptSimHash: null,
};
const personalContext: MicrodollarUsageContext = {
  ...context,
  bouncer: personalBouncer,
};

describe('production FRA queued accounting', () => {
  function configureFra(overrides: Record<string, string | undefined> = {}) {
    configureQueueEnvironment({
      VERCEL_REGION: 'fra1',
      USAGE_QUEUE_SFO_EXPOSURE: '0',
      USAGE_QUEUE_FRA_EXPOSURE: '1',
      ...overrides,
    });
  }

  test.each([
    { name: 'unset', env: { USAGE_QUEUE_FRA_EXPOSURE: undefined }, queued: false },
    {
      name: 'SFO full exposure cannot enable FRA',
      env: { USAGE_QUEUE_FRA_EXPOSURE: undefined, USAGE_QUEUE_SFO_EXPOSURE: '1' },
      queued: false,
    },
    { name: 'empty', env: { USAGE_QUEUE_FRA_EXPOSURE: '' }, queued: false },
    { name: 'zero', env: { USAGE_QUEUE_FRA_EXPOSURE: '0' }, queued: false },
    { name: 'malformed', env: { USAGE_QUEUE_FRA_EXPOSURE: 'bad' }, queued: false },
    { name: 'hex', env: { USAGE_QUEUE_FRA_EXPOSURE: '0x1' }, queued: false },
    { name: 'nonfinite', env: { USAGE_QUEUE_FRA_EXPOSURE: 'Infinity' }, queued: false },
    { name: 'out of range', env: { USAGE_QUEUE_FRA_EXPOSURE: '1.01' }, queued: false },
    { name: 'negative', env: { USAGE_QUEUE_FRA_EXPOSURE: '-0.1' }, queued: false },
    { name: 'master off', env: { USAGE_QUEUE_ONLY_ENABLED: 'false' }, queued: false },
    { name: 'master missing', env: { USAGE_QUEUE_ONLY_ENABLED: undefined }, queued: false },
    { name: 'master malformed', env: { USAGE_QUEUE_ONLY_ENABLED: 'TRUE' }, queued: false },
    { name: 'outside cohort', env: { USAGE_QUEUE_FRA_EXPOSURE: '0.8961' }, queued: false },
    { name: 'inside cohort', env: { USAGE_QUEUE_FRA_EXPOSURE: '0.8962' }, queued: true },
    { name: 'all FRA', env: {}, queued: true },
    { name: 'SFO allowlist ignored', env: { USAGE_QUEUE_SFO_USER_IDS: '[]' }, queued: true },
    { name: 'SFO malformed list ignored', env: { USAGE_QUEUE_SFO_USER_IDS: 'bad' }, queued: true },
    { name: 'SFO', env: { VERCEL_REGION: 'sfo1' }, queued: false },
    { name: 'unknown region', env: { VERCEL_REGION: 'iad1' }, queued: false },
    { name: 'absent region', env: { VERCEL_REGION: undefined }, queued: false },
    { name: 'empty region', env: { VERCEL_REGION: '' }, queued: false },
    { name: 'missing environment', env: { VERCEL_ENV: undefined }, queued: false },
    { name: 'missing target', env: { VERCEL_TARGET_ENV: undefined }, queued: false },
    {
      name: 'preview',
      env: { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' },
      queued: false,
    },
    {
      name: 'development',
      env: { VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development' },
      queued: false,
    },
    {
      name: 'production with staging target',
      env: { VERCEL_TARGET_ENV: 'staging' },
      queued: false,
    },
    { name: 'preview with production target', env: { VERCEL_ENV: 'preview' }, queued: false },
    {
      name: 'staging preserved',
      env: { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging', USAGE_QUEUE_FRA_EXPOSURE: '0' },
      queued: true,
    },
  ])('$name uses exactly one existing accounting path', async ({ env, queued }) => {
    configureFra(env);
    const lifecycle = requestLifetime();
    const record = await lifecycle.run(() =>
      logMicrodollarUsage({ ...stats }, { ...personalContext })
    );
    lifecycle.close();
    await lifecycle.drain();
    expect(record?.status).toBe(queued ? 'queued' : 'recorded');
    expect(publisher.enqueueUsage).toHaveBeenCalledTimes(queued ? 1 : 0);
    expect(fetch).toHaveBeenCalledTimes(queued ? 1 : 0);
    expect(writer).toHaveBeenCalledTimes(!queued && process.env.VERCEL_REGION === 'sfo1' ? 1 : 0);
    expect(db.transaction).toHaveBeenCalledTimes(
      !queued && process.env.VERCEL_REGION !== 'sfo1' ? 1 : 0
    );
    if (queued) expect(sent[0].core.id).toBe(record?.usageId);
    expect(lifecycle.errors).toEqual([]);
  });

  test.each(['0', '1'])('FRA exposure %s preserves SFO cohort and allowlist', async exposure => {
    for (const [sfoExposure, userIds, queued] of [
      ['0.3', '', false],
      ['0.31', '', true],
      ['1', '[]', false],
    ] as const) {
      jest.clearAllMocks();
      configureQueueEnvironment({
        USAGE_QUEUE_FRA_EXPOSURE: exposure,
        USAGE_QUEUE_SFO_EXPOSURE: sfoExposure,
        USAGE_QUEUE_SFO_USER_IDS: userIds,
      });
      const lifecycle = requestLifetime();
      const result = await lifecycle.run(() =>
        logMicrodollarUsage({ ...stats }, { ...personalContext })
      );
      lifecycle.close();
      await lifecycle.drain();
      expect(result?.status).toBe(queued ? 'queued' : 'recorded');
      expect(publisher.enqueueUsage).toHaveBeenCalledTimes(queued ? 1 : 0);
      expect(writer).toHaveBeenCalledTimes(queued ? 0 : 1);
      expect(db.transaction).not.toHaveBeenCalled();
    }
  });

  test.each([
    { organizationId: 'a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6' },
    { user_byok: true },
    { is_free: true },
    { bouncer: undefined },
    { bouncer: { ...personalBouncer, spendWatch: true } },
    { botId: 'synthetic-bot' },
  ])('FRA selection remains transport-only for %j', async change => {
    configureFra();
    const lifecycle = requestLifetime();
    const result = await lifecycle.run(() =>
      logMicrodollarUsage({ ...stats }, { ...personalContext, ...change })
    );
    lifecycle.close();
    await lifecycle.drain();
    expect(result?.status).toBe('queued');
    expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  test('FRA publication rejection does not fall back to direct accounting', async () => {
    configureFra();
    jest.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));
    const lifecycle = requestLifetime();
    const result = await lifecycle.run(() =>
      logMicrodollarUsage({ ...stats }, { ...personalContext })
    );
    lifecycle.close();
    await lifecycle.drain();
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  test.each(['publisher_not_configured', 'registration_failed'])(
    'FRA retains pre-I/O direct fallback for %s',
    async reason => {
      configureFra();
      jest.mocked(publisher.enqueueUsage).mockResolvedValue({ kind: 'unavailable', reason });
      const lifecycle = requestLifetime();
      const result = await lifecycle.run(() =>
        logMicrodollarUsage({ ...stats }, { ...personalContext })
      );
      lifecycle.close();
      await lifecycle.drain();
      expect(result?.status).toBe('recorded');
      expect(fetch).not.toHaveBeenCalled();
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(writer).not.toHaveBeenCalled();
    }
  );

  test('FRA internal writer does not enqueue even when its payer is selected', async () => {
    configureFra();
    const lifecycle = requestLifetime();
    const queued = await lifecycle.run(() =>
      logMicrodollarUsage({ ...stats }, { ...personalContext })
    );
    lifecycle.close();
    await lifecycle.drain();
    const payload = sent[0];
    expect(payload.core.id).toBe(queued?.usageId);
    jest.clearAllMocks();
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
    expect(publisher.enqueueUsage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('production SFO queued accounting', () => {
  test.each([
    { name: 'eligible SFO', env: {}, queued: true },
    { name: 'FRA', env: { VERCEL_REGION: 'fra1' }, queued: false },
    { name: 'unknown region', env: { VERCEL_REGION: 'iad1' }, queued: false },
    { name: 'missing region', env: { VERCEL_REGION: '' }, queued: false },
    { name: 'absent region', env: { VERCEL_REGION: undefined }, queued: false },
    { name: 'missing master', env: { USAGE_QUEUE_ONLY_ENABLED: undefined }, queued: false },
    { name: 'master off', env: { USAGE_QUEUE_ONLY_ENABLED: 'false' }, queued: false },
    { name: 'malformed master', env: { USAGE_QUEUE_ONLY_ENABLED: 'TRUE' }, queued: false },
    { name: 'missing exposure', env: { USAGE_QUEUE_SFO_EXPOSURE: undefined }, queued: false },
    { name: 'zero exposure', env: { USAGE_QUEUE_SFO_EXPOSURE: '0' }, queued: false },
    { name: 'invalid exposure', env: { USAGE_QUEUE_SFO_EXPOSURE: '1.01' }, queued: false },
    { name: 'malformed exposure', env: { USAGE_QUEUE_SFO_EXPOSURE: 'true' }, queued: false },
    { name: 'hex exposure', env: { USAGE_QUEUE_SFO_EXPOSURE: '0x1' }, queued: false },
    { name: 'binary exposure', env: { USAGE_QUEUE_SFO_EXPOSURE: '0b1' }, queued: false },
    { name: 'octal exposure', env: { USAGE_QUEUE_SFO_EXPOSURE: '0o1' }, queued: false },
    { name: 'nonfinite exposure', env: { USAGE_QUEUE_SFO_EXPOSURE: 'Infinity' }, queued: false },
    { name: 'negative exposure', env: { USAGE_QUEUE_SFO_EXPOSURE: '-0.01' }, queued: false },
    {
      name: 'legacy percentage cannot enable selection',
      env: { USAGE_QUEUE_SFO_EXPOSURE: undefined, USAGE_QUEUE_SFO_PERCENT: '1' },
      queued: false,
    },
    {
      name: 'legacy full percentage cannot enable selection',
      env: { USAGE_QUEUE_SFO_EXPOSURE: undefined, USAGE_QUEUE_SFO_PERCENT: '100' },
      queued: false,
    },
    { name: 'outside bucket', env: { USAGE_QUEUE_SFO_EXPOSURE: '0.3' }, queued: false },
    { name: 'inside bucket', env: { USAGE_QUEUE_SFO_EXPOSURE: '0.31' }, queued: true },
    {
      name: 'preview',
      env: {
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'preview',
      },
      queued: false,
    },
    { name: 'missing Vercel env', env: { VERCEL_ENV: undefined }, queued: false },
    { name: 'missing target', env: { VERCEL_TARGET_ENV: undefined }, queued: false },
    { name: 'mismatched target', env: { VERCEL_TARGET_ENV: 'staging' }, queued: false },
    {
      name: 'internal allowlist',
      env: { USAGE_QUEUE_SFO_USER_IDS: '["oauth/synthetic"]' },
      queued: true,
    },
    {
      name: 'unlisted payer',
      env: { USAGE_QUEUE_SFO_USER_IDS: '["someone-else"]' },
      queued: false,
    },
    { name: 'malformed list', env: { USAGE_QUEUE_SFO_USER_IDS: 'not-json' }, queued: false },
    {
      name: 'list cannot override zero',
      env: { USAGE_QUEUE_SFO_USER_IDS: '["oauth/synthetic"]', USAGE_QUEUE_SFO_EXPOSURE: '0' },
      queued: false,
    },
  ])('$name uses one accounting path', async ({ env, queued }) => {
    configureQueueEnvironment(env);
    const lifecycle = requestLifetime();
    const record = await lifecycle.run(() =>
      logMicrodollarUsage({ ...stats }, { ...personalContext })
    );
    lifecycle.close();
    await lifecycle.drain();
    expect(record?.status).toBe(queued ? 'queued' : 'recorded');
    expect(publisher.enqueueUsage).toHaveBeenCalledTimes(queued ? 1 : 0);
    if (queued) {
      expect(publisher.enqueueUsage).toHaveBeenCalledWith(expect.anything(), {
        retryTransientFailures: true,
      });
      expect(sent[0].core.id).toBe(record?.usageId);
    }
    expect(writer).toHaveBeenCalledTimes(!queued && process.env.VERCEL_REGION === 'sfo1' ? 1 : 0);
    expect(db.transaction).toHaveBeenCalledTimes(
      !queued && process.env.VERCEL_REGION !== 'sfo1' ? 1 : 0
    );
    expect(lifecycle.errors).toEqual([]);
  });

  test.each([
    { name: 'organization', change: { organizationId: '11111111-1111-4111-8111-111111111111' } },
    { name: 'spendWatch', change: { bouncer: { ...personalBouncer, spendWatch: true } } },
    {
      name: 'unknown spend-watch status',
      change: { bouncer: { ...personalBouncer, spendWatch: undefined } },
    },
    { name: 'bot', change: { botId: 'synthetic-bot' } },
    { name: 'missing Bouncer / classifier context', change: { bouncer: undefined } },
    {
      name: 'anonymous Bouncer context',
      change: { bouncer: { ...personalBouncer, accountId: null } },
    },
    { name: 'free model', change: { is_free: true } },
    { name: 'BYOK', change: { user_byok: true } },
  ])('$name still uses the selected queue transport', async ({ change }) => {
    configureQueueEnvironment();
    const lifecycle = requestLifetime();
    const record = await lifecycle.run(() =>
      logMicrodollarUsage({ ...stats }, { ...personalContext, ...change })
    );
    lifecycle.close();
    await lifecycle.drain();
    expect(record?.status).toBe('queued');
    expect(writer).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  test.each([false, true])(
    'selected SFO accounting retains existing Bouncer reporting (spendWatch=%s)',
    async spendWatch => {
      configureQueueEnvironment();
      const report = jest.requireMock<{ reportUsageEvent: jest.Mock }>(
        '@kilocode/web-shared/lib/bouncer/client'
      ).reportUsageEvent;
      const lifecycle = requestLifetime();
      const record = await lifecycle.run(() =>
        logMicrodollarUsageAndReportToBouncer(
          { ...stats },
          {
            ...personalContext,
            bouncer: { ...personalBouncer, spendWatch },
          }
        )
      );
      lifecycle.close();
      await lifecycle.drain();
      expect(record?.status).toBe('queued');
      expect(sent).toHaveLength(1);
      expect(sent[0].bouncer_usage_event).toEqual(
        spendWatch ? expect.objectContaining({ request_id: personalBouncer.requestId }) : null
      );
      expect(report).toHaveBeenCalledTimes(spendWatch ? 0 : 1);
      expect(bouncer.deliverBouncerUsageEventNow).not.toHaveBeenCalled();
      expect(outbox.enqueueBouncerUsageEvent).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    }
  );

  test.each(['no_scope', 'no_wait_until'])(
    '%s falls back to direct accounting instead of dropping selected usage',
    async missing => {
      configureQueueEnvironment();
      const work = () => logMicrodollarUsage({ ...stats }, { ...personalContext });
      const record = await (missing === 'no_scope' ? work() : requestLifetime(false).run(work));
      expect(record?.status).toBe('recorded');
      expect(publisher.enqueueUsage).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(writer).toHaveBeenCalledTimes(1);
      expect(writer.mock.calls[0][0].core.id).toBe(record?.usageId);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    }
  );

  test('selected production mode retries a real HTTP publication with the same finalized identity', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    configureQueueEnvironment();
    const bodies: UsageRecordRequest[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as UsageRecordRequest);
      response.writeHead(bodies.length === 1 ? 503 : 202).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing local HTTP address');
      config.USAGE_INGEST_URL = `http://127.0.0.1:${address.port}/usage`;
      jest.mocked(fetch).mockImplementation(nativeFetch);
      const lifetime = requestLifetime();
      const result = await lifetime.run(() =>
        logMicrodollarUsage({ ...stats }, { ...personalContext })
      );
      lifetime.close();
      await lifetime.drain();
      expect(result).toMatchObject({ status: 'queued', usageId: bodies[0].core.id });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[0].metadata.id).toBe(bodies[0].core.id);
      expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
      expect(writer).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(lifetime.errors).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    }
  });

  test('selected missing_config writes the row directly instead of dropping it', async () => {
    configureQueueEnvironment();
    config.USAGE_INGEST_URL = '';
    advancePublisherReportClock();
    const lifetime = requestLifetime();
    const result = await lifetime.run(() =>
      logMicrodollarUsage({ ...stats }, { ...personalContext })
    );
    lifetime.close();
    await lifetime.drain();
    expect(result?.status).toBe('recorded');
    expect(fetch).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(lifetime.errors).toEqual([]);
  });

  test('selected malformed URL writes the row directly instead of dropping it', async () => {
    configureQueueEnvironment();
    config.USAGE_INGEST_URL = 'usage.example.test/missing-scheme';
    advancePublisherReportClock();
    const lifetime = requestLifetime();
    const result = await lifetime.run(() =>
      logMicrodollarUsage({ ...stats }, { ...personalContext })
    );
    lifetime.close();
    await lifetime.drain();
    expect(result?.status).toBe('recorded');
    expect(fetch).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(lifetime.errors).toEqual([]);
  });

  test('selected timeout returns failed accounting without direct fallback', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    configureQueueEnvironment();
    const nativeTimeout = AbortSignal.timeout;
    jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(5));
    jest.mocked(fetch).mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(init?.body as string) as UsageRecordRequest);
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('synthetic-timeout')), {
          once: true,
        })
      );
    });
    const lifetime = requestLifetime();
    const result = await lifetime.run(() =>
      logMicrodollarUsage({ ...stats }, { ...personalContext })
    );
    lifetime.close();
    await lifetime.drain();
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(publisher.USAGE_ENQUEUE_MAX_ATTEMPTS);
    expect(sent).toEqual(Array(publisher.USAGE_ENQUEUE_MAX_ATTEMPTS).fill(sent[0]));
    expect(writer).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(lifetime.errors).toEqual([]);
  });

  test('writes every unconfigured-publisher row but reports at most once per interval', async () => {
    configureQueueEnvironment();
    config.USAGE_INGEST_PUBLISH_SECRET = '';
    const record = async () => {
      const lifetime = requestLifetime();
      const result = await lifetime.run(() =>
        logMicrodollarUsage({ ...stats }, { ...personalContext })
      );
      lifetime.close();
      await lifetime.drain();
      return result;
    };
    advancePublisherReportClock();
    const first = await record();
    const second = await record();
    expect([first?.status, second?.status]).toEqual(['recorded', 'recorded']);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    advancePublisherReportClock();
    const third = await record();
    expect(third?.status).toBe('recorded');
    expect(sentry.captureMessage).toHaveBeenCalledTimes(2);
    const directFallbacks = warn.mock.calls.filter(
      ([message]) => message === 'usage accounting queue publisher not configured'
    );
    expect(directFallbacks).toEqual(
      Array.from({ length: 3 }, () => [
        'usage accounting queue publisher not configured',
        { usageId: expect.any(String), fallback: 'direct' },
      ])
    );
    expect(error).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(3);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('an attached durable enforcement event follows the selected queue transport', async () => {
    configureQueueEnvironment();
    const lifetime = requestLifetime();
    const result = await lifetime.run(() =>
      logMicrodollarUsage(
        { ...stats },
        { ...personalContext },
        { request_id: 'synthetic', payload: { cost: 1234 } }
      )
    );
    lifetime.close();
    await lifetime.drain();
    expect(result?.status).toBe('queued');
    expect(writer).not.toHaveBeenCalled();
    expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
    expect(sent[0].bouncer_usage_event).toEqual({
      request_id: 'synthetic',
      payload: { cost: 1234 },
    });
  });

  test.each([202, 401, 503])(
    'selected late after() work tracks HTTP %s without a second accounting path',
    async status => {
      if (status === 503) jest.spyOn(Math, 'random').mockReturnValue(0);
      configureQueueEnvironment();
      const lifetime = requestLifetime();
      const generation = Promise.withResolvers<void>();
      const accepted = Promise.withResolvers<Response>();
      jest.mocked(fetch).mockImplementation(
        (_url, init) =>
          new Promise((resolve, reject) => {
            const signal = init?.signal;
            const abort = () => reject(new Error('synthetic timeout'));
            signal?.addEventListener('abort', abort, { once: true });
            void accepted.promise.then(response => {
              signal?.removeEventListener('abort', abort);
              resolve(response);
            });
          })
      );
      let result: Awaited<ReturnType<typeof logMicrodollarUsage>> = null;
      lifetime.run(() => {
        after(() => {});
        after(
          (async () => {
            await generation.promise;
            result = await logMicrodollarUsage({ ...stats }, { ...personalContext });
          })()
        );
      });
      lifetime.close();
      await lifetime.pending[0];
      generation.resolve();
      await new Promise(resolve => setImmediate(resolve));
      let drained = false;
      const drain = lifetime.drain().then(() => {
        drained = true;
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(drained).toBe(false);
      config.USAGE_QUEUE_SFO_CONFIG = { enabled: false, exposure: 0, userIds: null };
      if (status === 202) await new Promise(resolve => setTimeout(resolve, 3_000));
      accepted.resolve(new Response(null, { status }));
      await drain;
      expect(result).toEqual(status === 202 ? expect.objectContaining({ status: 'queued' }) : null);
      expect(fetch).toHaveBeenCalledTimes(
        status === 503 ? publisher.USAGE_ENQUEUE_MAX_ATTEMPTS : 1
      );
      const bodies = jest.mocked(fetch).mock.calls.map(([, init]) => init?.body);
      expect(new Set(bodies).size).toBe(1);
      expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
      expect(writer).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(lifetime.errors).toEqual([]);
    }
  );
});

describe('gateway accounting integration', () => {
  test.each(
    ['fra1', 'sfo1'].flatMap(region => [
      { region, target: 'staging', environment: 'preview' },
      { region, target: 'production', environment: 'production' },
    ])
  )(
    'legacy shadow env cannot publish on $target $region direct accounting',
    async ({ region, target, environment }) => {
      const original = { ...process.env };
      try {
        process.env.USAGE_SHADOW_PUBLISH_ENABLED = 'true';
        configureQueueEnvironment({
          USAGE_QUEUE_ONLY_ENABLED: 'false',
          VERCEL_REGION: region,
          VERCEL_ENV: environment,
          VERCEL_TARGET_ENV: target,
        });
        jest.isolateModules(() => {
          const actual = jest.requireActual<typeof ServerConfig>(
            '@kilocode/web-shared/lib/config.server'
          );
          expect(actual).not.toHaveProperty('USAGE_SHADOW_PUBLISH_ENABLED');
        });
        const lifecycle = requestLifetime();
        const record = await lifecycle.run(() => logMicrodollarUsage({ ...stats }, { ...context }));
        lifecycle.close();
        await lifecycle.drain();
        expect(record?.status).toBe('recorded');
        expect(publisher.enqueueUsage).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(writer).toHaveBeenCalledTimes(region === 'sfo1' ? 1 : 0);
        expect(db.transaction).toHaveBeenCalledTimes(region === 'fra1' ? 1 : 0);
      } finally {
        process.env = original;
      }
    }
  );

  test('direct accounting does not register publication even with configured transport', async () => {
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
      expect(warn).not.toHaveBeenCalled();
    }
  );

  test.each(['no_scope', 'no_wait_until'])(
    '%s skips usage auto-top-up without reporting a post-commit failure',
    async missing => {
      autoTopUpUser = enabledAutoTopUpUser;
      const work = () => logMicrodollarUsage({ ...stats }, { ...context });
      const result = await (missing === 'no_scope' ? work() : requestLifetime(false).run(work));
      expect(result).not.toBeNull();
      expect(autoTopUp.maybePerformAutoTopUp).not.toHaveBeenCalled();
      expect(sentry.captureException).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('usage auto-top-up unavailable', {
        usageId: result?.usageId,
        reason: 'registration_failed',
      });
    }
  );

  test('schedules usage auto-top-up after the response inside a request scope', async () => {
    autoTopUpUser = enabledAutoTopUpUser;
    const lifecycle = requestLifetime();
    expect(
      await lifecycle.run(() => logMicrodollarUsage({ ...stats }, { ...context }))
    ).not.toBeNull();
    expect(autoTopUp.maybePerformAutoTopUp).not.toHaveBeenCalled();
    lifecycle.close();
    await lifecycle.drain();
    expect(autoTopUp.maybePerformAutoTopUp).toHaveBeenCalledWith(enabledAutoTopUpUser);
    expect(warn).not.toHaveBeenCalled();
    expect(lifecycle.errors).toEqual([]);
  });

  test.each(['fra1', 'sfo1'])(
    '%s sends the exact finalized event once, with one ID and complete bouncer data',
    async region => {
      config.USAGE_QUEUE_ONLY_ENABLED = true;
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
      expect(record?.status).toBe('queued');
      expect(writer).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(outbox.enqueueBouncerUsageEvent).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith('usage accounting queued', {
        usageId: record?.usageId,
      });
      expect(warn).not.toHaveBeenCalled();
      expect(lifecycle.errors).toEqual([]);
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
    expect(sent).toHaveLength(0);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const payload: UsageRecordRequest = writer.mock.calls[0][0];
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
    expect(sent).toHaveLength(0);
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
      config.USAGE_QUEUE_ONLY_ENABLED = true;
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
      expect(writer).not.toHaveBeenCalled();
    }
  );

  test.each([
    { generationFinishReason: null, expected: 'refusal' },
    { generationFinishReason: 'content_filter', expected: 'content_filter' },
  ])(
    'processTokenData keeps the response finish_reason only when the generation lookup has none ($generationFinishReason)',
    async ({ generationFinishReason, expected }) => {
      config.USAGE_QUEUE_ONLY_ENABLED = true;
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

  test.each(['fra1', 'sfo1'])(
    '%s confirmed acceptance queues once without a direct write',
    async region => {
      config.USAGE_QUEUE_ONLY_ENABLED = true;

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
      if (status === 503) jest.spyOn(Math, 'random').mockReturnValue(0);
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
      jest.spyOn(Math, 'random').mockReturnValue(0);
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
      '$region accounts for $failure without publishing a duplicate',
      async ({ region, failure }) => {
        if (['http_503', 'timeout', 'transport_failure'].includes(failure))
          jest.spyOn(Math, 'random').mockReturnValue(0);
        config.USAGE_QUEUE_ONLY_ENABLED = true;
        process.env.VERCEL_REGION = region;
        fetchGeneration.mockResolvedValue(null);
        if (failure === 'timeout') {
          const nativeTimeout = AbortSignal.timeout;
          jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(5));
        }
        if (failure.startsWith('missing')) advancePublisherReportClock();
        if (failure === 'missing_url') config.USAGE_INGEST_URL = '';
        else if (failure === 'missing_secret') config.USAGE_INGEST_PUBLISH_SECRET = '';
        else if (failure === 'unexpected_rejection')
          jest
            .mocked(publisher.enqueueUsage)
            .mockRejectedValue(new Error('sensitive-secret-prompt'));
        else
          jest.mocked(fetch).mockImplementation(async (_url, init) => {
            sent.push(JSON.parse(init?.body as string) as UsageRecordRequest);
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
        if (failure.startsWith('missing')) {
          // Nothing was published, so the row is written directly instead of dropped.
          expect(record).toEqual({
            status: 'recorded',
            usageId: payload.core.id,
            createdAt: payload.core.created_at,
          });
          if (region === 'sfo1') {
            const handoff = writer.mock.calls[0][0] as UsageRecordRequest;
            expect(writer).toHaveBeenCalledTimes(1);
            expect(handoff.core.id).toBe(payload.core.id);
            expect(handoff.metadata.id).toBe(payload.core.id);
            expect(db.transaction).not.toHaveBeenCalled();
          } else {
            expect(writer).not.toHaveBeenCalled();
            expect(db.transaction).toHaveBeenCalledTimes(1);
          }
          expect(error).not.toHaveBeenCalled();
          expect(warn).toHaveBeenCalledWith('usage accounting queue publisher not configured', {
            usageId: payload.core.id,
            fallback: 'direct',
          });
          expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
          // Frankfurt writes locally and emits the shared completion record. An SFO write
          // happens inside the Frankfurt endpoint, so only its response comes back.
          if (region === 'sfo1') expect(completionLogs).toEqual([]);
          else
            expect(completionLogs.map(value => JSON.parse(value))).toEqual([
              expect.objectContaining({
                outcome: 'recorded',
                usage_id: payload.core.id,
                execution_region: 'fra1',
              }),
            ]);
          // The attached event rides the direct write, so the gateway never reports it.
          expect(report).not.toHaveBeenCalled();
        } else {
          // The queue may hold the event, so no direct write and no second Bouncer report.
          expect(record).toBeNull();
          expect(writer).not.toHaveBeenCalled();
          expect(db.transaction).not.toHaveBeenCalled();
          expect(error).toHaveBeenCalledTimes(1);
          expect(error).toHaveBeenCalledWith('usage accounting publication failed', {
            usageId: payload.core.id,
            reason: failure === 'transport_failure' ? 'request_failed' : failure,
          });
          expect(report).toHaveBeenCalledTimes(reportsUsage ? 1 : 0);
          expect(sentry.captureMessage).not.toHaveBeenCalled();
          expect(completionLogs).toEqual([]);
        }
        expect(outbox.enqueueBouncerUsageEvent).toHaveBeenCalledTimes(
          failure.startsWith('missing') && reportsUsage && region === 'fra1' ? 1 : 0
        );
        // A direct write is this outbox row's first delivery; the handoff delivers it in Frankfurt.
        expect(bouncer.deliverBouncerUsageEventNow).toHaveBeenCalledTimes(
          region === 'fra1' && failure.startsWith('missing') && reportsUsage ? 1 : 0
        );
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
        expect(lifecycle.errors).toEqual([]);
      }
    );

    test.each(
      ['fra1', 'sfo1'].flatMap(region =>
        ['no_scope', 'no_wait_until'].map(missing => ({ region, missing }))
      )
    )(
      '$region / $missing falls back to direct accounting instead of dropping usage',
      async ({ region, missing }) => {
        config.USAGE_QUEUE_ONLY_ENABLED = true;
        process.env.VERCEL_REGION = region;
        fetchGeneration.mockResolvedValue(null);
        const lifecycle = requestLifetime(false);
        const work = () => run({ ...stats }, { ...watchedContext });
        const record = await (missing === 'no_scope' ? work() : lifecycle.run(work));
        lifecycle.close();
        await lifecycle.drain();
        expect(record).toMatchObject({ status: 'recorded', usageId: expect.any(String) });
        expect(publisher.enqueueUsage).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
        const attachedEvent = reportsUsage
          ? expect.objectContaining({ request_id: 'synthetic-request' })
          : null;
        if (region === 'sfo1') {
          expect(writer).toHaveBeenCalledTimes(1);
          expect(writer).toHaveBeenCalledWith(
            expect.objectContaining({
              core: expect.objectContaining({ id: record?.usageId }),
              metadata: expect.objectContaining({ id: record?.usageId }),
              bouncer_usage_event: attachedEvent,
            })
          );
          expect(db.transaction).not.toHaveBeenCalled();
          expect(outbox.enqueueBouncerUsageEvent).not.toHaveBeenCalled();
          expect(bouncer.deliverBouncerUsageEventNow).not.toHaveBeenCalled();
        } else {
          expect(writer).not.toHaveBeenCalled();
          expect(db.transaction).toHaveBeenCalledTimes(1);
          expect(outbox.enqueueBouncerUsageEvent).toHaveBeenCalledTimes(reportsUsage ? 1 : 0);
          expect(bouncer.deliverBouncerUsageEventNow).toHaveBeenCalledTimes(reportsUsage ? 1 : 0);
        }
        expect(report).not.toHaveBeenCalled();
        expect(sentry.captureMessage).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(warn.mock.calls).toEqual([
          [
            'usage accounting queue unavailable without a request lifetime',
            { usageId: record?.usageId, reason: 'registration_failed', fallback: 'direct' },
          ],
        ]);
        expect(info).not.toHaveBeenCalled();
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
      if (status === 503) jest.spyOn(Math, 'random').mockReturnValue(0);
      config.USAGE_QUEUE_ONLY_ENABLED = true;
      process.env.VERCEL_REGION = region;
      jest.mocked(fetch).mockImplementation(async (_url, init) => {
        sent.push(JSON.parse(init?.body as string) as UsageRecordRequest);
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

  test.each(['fra1', 'sfo1'])('queue off keeps %s direct billing', async region => {
    process.env.VERCEL_REGION = region;
    config.USAGE_QUEUE_ONLY_ENABLED = false;

    const lifecycle = requestLifetime();
    const record = await lifecycle.run(() => logMicrodollarUsage({ ...stats }, { ...context }));
    lifecycle.close();
    await lifecycle.drain();
    expect(record?.status).toBe('recorded');
    expect(publisher.enqueueUsage).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(region === 'sfo1' ? 1 : 0);
    expect(db.transaction).toHaveBeenCalledTimes(region === 'fra1' ? 1 : 0);
    expect(error).not.toHaveBeenCalled();
  });

  test('queue off retains failed direct accounting and best-effort Bouncer reporting', async () => {
    config.USAGE_QUEUE_ONLY_ENABLED = false;

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

describe('prompt ordinary Bouncer reports for the selected queue transport', () => {
  const client = jest.requireMock<{ reportUsageEvent: jest.Mock; usageEventWireBody: jest.Mock }>(
    '@kilocode/web-shared/lib/bouncer/client'
  );
  const selected = [
    { name: 'production SFO', env: {} },
    {
      name: 'staging FRA',
      env: { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging', VERCEL_REGION: 'fra1' },
    },
    {
      name: 'staging SFO',
      env: { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging', VERCEL_REGION: 'sfo1' },
    },
  ];
  beforeEach(() => {
    client.reportUsageEvent.mockResolvedValue(undefined);
    fetchGeneration.mockResolvedValue(null);
  });

  test.each(
    selected.flatMap(selection =>
      ['promise', 'function', 'late'].flatMap(mode =>
        ['report_first', 'publication_first'].map(order => ({ ...selection, mode, order }))
      )
    )
  )(
    '$name / $mode / $order starts one ordinary report before acceptance and awaits both',
    async ({ env, mode, order }) => {
      configureQueueEnvironment(env);
      const publicationStarted = Promise.withResolvers<void>();
      const acceptance = Promise.withResolvers<Response>();
      const reportDone = Promise.withResolvers<void>();
      jest.mocked(fetch).mockImplementation(async (_url, init) => {
        sent.push(JSON.parse(init?.body as string) as UsageRecordRequest);
        publicationStarted.resolve();
        return acceptance.promise;
      });
      client.reportUsageEvent.mockImplementation(() => reportDone.promise);
      const lifecycle = requestLifetime();
      if (mode === 'late') {
        lifecycle.run(() => after(() => {}));
        lifecycle.close();
        await lifecycle.drain();
      }
      let result: Awaited<ReturnType<typeof logMicrodollarUsageAndReportToBouncer>> = null;
      let completed = false;
      const work = async () => {
        result = await logMicrodollarUsageAndReportToBouncer({ ...stats }, { ...personalContext });
        completed = true;
      };
      lifecycle.run(() => after(mode === 'function' ? work : work()));
      if (mode !== 'late') lifecycle.close();
      let drained = false;
      const drain = lifecycle.drain().then(() => {
        drained = true;
      });
      try {
        await publicationStarted.promise;
        expect(client.reportUsageEvent).toHaveBeenCalledTimes(1);
        expect(client.reportUsageEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            requestId: personalBouncer.requestId,
            occurredAt: personalBouncer.occurredAt,
            accountId: personalBouncer.accountId,
            costMicrodollars: stats.cost_mUsd,
            inputTokens: stats.inputTokens,
            outputTokens: stats.outputTokens,
          })
        );
        expect(completed).toBe(false);
        expect(drained).toBe(false);
        if (order === 'report_first') reportDone.resolve();
        else acceptance.resolve(new Response(null, { status: 202 }));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(completed).toBe(false);
        expect(drained).toBe(false);
        expect(client.reportUsageEvent).toHaveBeenCalledTimes(1);
      } finally {
        reportDone.resolve();
        acceptance.resolve(new Response(null, { status: 202 }));
        await drain;
      }
      expect(completed).toBe(true);
      expect(drained).toBe(true);
      expect(result).toEqual({
        status: 'queued',
        usageId: sent[0].core.id,
        createdAt: sent[0].core.created_at,
      });
      expect(sent[0].metadata.id).toBe(sent[0].core.id);
      expect(sent[0].bouncer_usage_event).toBeNull();
      expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
      expect(client.usageEventWireBody).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(outbox.enqueueBouncerUsageEvent).not.toHaveBeenCalled();
      expect(lifecycle.errors).toEqual([]);
    }
  );

  test.each([false, true])(
    '503 retry retains one payload/report with spendWatch=%s',
    async spendWatch => {
      jest.spyOn(Math, 'random').mockReturnValue(0);
      configureQueueEnvironment();
      const retryStarted = Promise.withResolvers<void>();
      const accepted = Promise.withResolvers<Response>();
      jest.mocked(fetch).mockImplementation(async (_url, init) => {
        sent.push(JSON.parse(init?.body as string) as UsageRecordRequest);
        if (sent.length === 1) return new Response(null, { status: 503 });
        retryStarted.resolve();
        return accepted.promise;
      });
      const lifecycle = requestLifetime();
      let result: Awaited<ReturnType<typeof logMicrodollarUsageAndReportToBouncer>> = null;
      lifecycle.run(() =>
        after(async () => {
          result = await logMicrodollarUsageAndReportToBouncer(
            { ...stats },
            {
              ...personalContext,
              bouncer: { ...personalBouncer, spendWatch },
            }
          );
        })
      );
      lifecycle.close();
      const drain = lifecycle.drain();
      try {
        await retryStarted.promise;
        expect(client.reportUsageEvent).toHaveBeenCalledTimes(spendWatch ? 0 : 1);
        expect(result).toBeNull();
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual(sent[0]);
        if (spendWatch) {
          const payload = jest.mocked(publisher.enqueueUsage).mock.calls[0][0];
          expect(payload.bouncer_usage_event).toEqual({
            request_id: personalBouncer.requestId,
            payload: client.usageEventWireBody.mock.results[0].value,
          });
          expect(payload.bouncer_usage_event?.payload).toBe(
            client.usageEventWireBody.mock.results[0].value
          );
          expect(client.usageEventWireBody).toHaveBeenCalledTimes(1);
        } else expect(sent[0].bouncer_usage_event).toBeNull();
      } finally {
        accepted.resolve(new Response(null, { status: 202 }));
        await drain;
      }
      expect(result).toEqual({
        status: 'queued',
        usageId: sent[0].core.id,
        createdAt: sent[0].core.created_at,
      });
      expect(client.reportUsageEvent).toHaveBeenCalledTimes(spendWatch ? 0 : 1);
      expect(writer).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(outbox.enqueueBouncerUsageEvent).not.toHaveBeenCalled();
      expect(bouncer.deliverBouncerUsageEventNow).not.toHaveBeenCalled();
      expect(lifecycle.errors).toEqual([]);
    }
  );

  test.each([
    { name: 'production FRA', env: { VERCEL_REGION: 'fra1' } },
    { name: 'master off', env: { USAGE_QUEUE_ONLY_ENABLED: 'false' } },
    { name: 'zero exposure', env: { USAGE_QUEUE_SFO_EXPOSURE: '0' } },
    { name: 'unlisted SFO payer', env: { USAGE_QUEUE_SFO_USER_IDS: '["other"]' } },
  ])('$name preserves direct accounting-before-report order', async ({ env }) => {
    configureQueueEnvironment(env);
    const started = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    const originalWriter = writer.getMockImplementation();
    const originalTransaction = db.transaction.getMockImplementation();
    writer.mockImplementation(async (...args: unknown[]) => {
      started.resolve();
      await committed.promise;
      return originalWriter?.(...args);
    });
    db.transaction.mockImplementation(async (...args: unknown[]) => {
      started.resolve();
      await committed.promise;
      return originalTransaction?.(...args);
    });
    const lifecycle = requestLifetime();
    const work = lifecycle.run(() =>
      logMicrodollarUsageAndReportToBouncer({ ...stats }, { ...personalContext })
    );
    try {
      await started.promise;
      expect(client.reportUsageEvent).not.toHaveBeenCalled();
      expect(publisher.enqueueUsage).not.toHaveBeenCalled();
    } finally {
      committed.resolve();
    }
    expect(await work).toMatchObject({ status: 'recorded' });
    lifecycle.close();
    await lifecycle.drain();
    expect(client.reportUsageEvent).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledTimes(process.env.VERCEL_REGION === 'sfo1' ? 1 : 0);
    expect(db.transaction).toHaveBeenCalledTimes(process.env.VERCEL_REGION === 'fra1' ? 1 : 0);
    expect(lifecycle.errors).toEqual([]);
  });

  test.each(['not_configured', 'ambiguous_200', 'http_503', 'unexpected_rejection', 'no_scope'])(
    'ordinary report remains single when queued accounting writes directly: %s',
    async failure => {
      if (failure === 'http_503') jest.spyOn(Math, 'random').mockReturnValue(0);
      configureQueueEnvironment();
      if (failure === 'not_configured') {
        config.USAGE_INGEST_URL = '';
        advancePublisherReportClock();
      }
      if (failure === 'ambiguous_200')
        jest.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
      if (failure === 'http_503')
        jest.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
      if (failure === 'unexpected_rejection')
        jest
          .mocked(publisher.enqueueUsage)
          .mockRejectedValue(new Error('synthetic publisher rejection'));
      const lifecycle = requestLifetime();
      const work = () =>
        logMicrodollarUsageAndReportToBouncer({ ...stats }, { ...personalContext });
      const failuresThatFallBack = failure === 'not_configured' || failure === 'no_scope';
      const result = await (failure === 'no_scope' ? work() : lifecycle.run(work));
      lifecycle.close();
      await lifecycle.drain();
      // A direct write cannot have published the event, so the gateway still reports it once
      // and the Bouncer event rides the write instead of a second best-effort send.
      expect(result).toEqual(
        failuresThatFallBack ? expect.objectContaining({ status: 'recorded' }) : null
      );
      expect(client.reportUsageEvent).toHaveBeenCalledTimes(1);
      expect(client.usageEventWireBody).not.toHaveBeenCalled();
      expect(writer).toHaveBeenCalledTimes(
        failuresThatFallBack && process.env.VERCEL_REGION === 'sfo1' ? 1 : 0
      );
      expect(db.transaction).toHaveBeenCalledTimes(
        failuresThatFallBack && process.env.VERCEL_REGION === 'fra1' ? 1 : 0
      );
      // An ordinary event carries no durable Bouncer payload, so the direct write enqueues none.
      expect(outbox.enqueueBouncerUsageEvent).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(
        failure === 'http_503'
          ? publisher.USAGE_ENQUEUE_MAX_ATTEMPTS
          : failure === 'ambiguous_200'
            ? 1
            : 0
      );
      expect(lifecycle.errors).toEqual([]);
    }
  );

  test('missing event keeps queued accounting without any Bouncer report', async () => {
    configureQueueEnvironment();
    const lifecycle = requestLifetime();
    expect(
      await lifecycle.run(() => logMicrodollarUsageAndReportToBouncer({ ...stats }, { ...context }))
    ).toMatchObject({ status: 'queued' });
    lifecycle.close();
    await lifecycle.drain();
    expect(sent[0].bouncer_usage_event).toBeNull();
    expect(client.reportUsageEvent).not.toHaveBeenCalled();
    expect(publisher.enqueueUsage).toHaveBeenCalledTimes(1);
  });

  test.each([{ is_free: true }, { user_byok: true }])(
    'processTokenData reports finalized zero cost for %p',
    async change => {
      configureQueueEnvironment();
      const lifecycle = requestLifetime();
      expect(
        await lifecycle.run(() => processTokenData({ ...stats }, { ...personalContext, ...change }))
      ).toMatchObject({ status: 'queued' });
      lifecycle.close();
      await lifecycle.drain();
      expect(client.reportUsageEvent).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: personalBouncer.requestId, costMicrodollars: 0 })
      );
      expect(sent[0].core.cost).toBe(0);
      expect(sent[0].bouncer_usage_event).toBeNull();
      expect(writer).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    }
  );
});

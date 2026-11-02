import type * as VercelPublisher from '@kilocode/usage-queue/vercel/publisher';
jest.mock('@kilocode/usage-queue/vercel/publisher', () => ({ enqueueVercelUsage: jest.fn() }));
jest.mock('@kilocode/usage-queue/vercel/config', () => ({ USAGE_VERCEL_QUEUE_ENABLED: false }));
import type * as UsagePublisher from '@kilocode/web-shared/lib/ai-gateway/usage-publisher';
import type * as UsageProcessing from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import type * as NextServer from 'next/server';
import type * as NextUnit from 'next/dist/server/app-render/work-unit-async-storage.external';
import type * as NextWork from 'next/dist/server/app-render/work-async-storage.external';
import type * as NextAfter from 'next/dist/server/after/after-context';
import { beforeEach, afterEach, describe, expect, test } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  isUSRegion: () => process.env.VERCEL_REGION === 'sfo1',
  db: {
    transaction: jest.fn(),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    query: { microdollar_usage: { findFirst: jest.fn() } },
  },
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  USAGE_QUEUE_SFO_CONFIG: { enabled: false, exposure: 0, userIds: null },
  USAGE_QUEUE_ONLY_ENABLED: false,
  USAGE_INGEST_URL: 'http://usage.example.test/usage',
  USAGE_INGEST_PUBLISH_SECRET: 'synthetic-local-secret',
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/usage-publisher', () => {
  const actual = jest.requireActual<typeof UsagePublisher>(
    '@kilocode/web-shared/lib/ai-gateway/usage-publisher'
  );
  return { ...actual, enqueueUsage: jest.fn(actual.enqueueUsage) };
});
jest.mock('@kilocode/web-shared/lib/ai-gateway/usage-record-client', () => ({
  recordUsageInPrimaryRegion: jest.fn(),
}));
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
jest.mock('@kilocode/web-shared/lib/ai-gateway/usage-daily-rollup-repairs', () => ({
  enqueueDailyUsageRollupRepair: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/kilo-pass-org/consumption', () => ({}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  sentryLogger: () => () => {},
  logExceptInTest: () => {},
  warnExceptInTest: () => {},
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/upstream-request', () => ({
  fetchGeneration: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-pricing', () => ({
  calculateCustomCost_mUsd: () => undefined,
}));
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
const { enqueueVercelUsage } = jest.requireMock<typeof VercelPublisher>(
  '@kilocode/usage-queue/vercel/publisher'
);
const queueConfig = jest.requireMock<{ USAGE_VERCEL_QUEUE_ENABLED: boolean }>(
  '@kilocode/usage-queue/vercel/config'
);
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
const { processTokenData } = jest.requireActual<typeof UsageProcessing>(
  '@kilocode/web-shared/lib/ai-gateway/processUsage'
);
const publisher = jest.requireMock<typeof UsagePublisher>(
  '@kilocode/web-shared/lib/ai-gateway/usage-publisher'
);
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
  '@kilocode/web-shared/lib/ai-gateway/usage-record-client'
).recordUsageInPrimaryRegion;
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
let warn: jest.SpyInstance<ReturnType<typeof console.warn>, Parameters<typeof console.warn>>;
let error: jest.SpyInstance<ReturnType<typeof console.error>, Parameters<typeof console.error>>;

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
      jest.requireActual<typeof UsagePublisher>(
        '@kilocode/web-shared/lib/ai-gateway/usage-publisher'
      ).enqueueUsage
    );
  config.USAGE_SHADOW_PUBLISH_ENABLED = false;
  config.USAGE_QUEUE_ONLY_ENABLED = false;
  queueConfig.USAGE_VERCEL_QUEUE_ENABLED = false;
  jest.mocked(enqueueVercelUsage).mockReset();
  process.env.VERCEL_REGION = 'fra1';
  jest.spyOn(console, 'info').mockImplementation(() => {});
  error = jest.spyOn(console, 'error').mockImplementation(() => {});
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.VERCEL_REGION;
});

describe('Vercel queued accounting lifetime', () => {
  test.each(
    ['fra1', 'sfo1'].flatMap(region =>
      ['promise', 'function', 'late'].flatMap(mode =>
        [true, false].map(accepted => ({ region, mode, accepted }))
      )
    )
  )(
    'awaits $region $mode acceptance=$accepted without another transport or writer',
    async ({ region, mode, accepted }) => {
      config.USAGE_QUEUE_ONLY_ENABLED = true;
      queueConfig.USAGE_VERCEL_QUEUE_ENABLED = true;
      config.USAGE_SHADOW_PUBLISH_ENABLED = true;
      process.env.VERCEL_REGION = region;
      const lifecycle = requestLifetime();
      const publication = Promise.withResolvers<Awaited<ReturnType<typeof enqueueVercelUsage>>>();
      const generation = Promise.withResolvers<void>();
      jest.mocked(enqueueVercelUsage).mockReturnValue(publication.promise);
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
      expect(enqueueVercelUsage).toHaveBeenCalledTimes(1);
      let drained = false;
      const drain = lifecycle.drain().then(() => {
        drained = true;
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(drained).toBe(false);
      const payload = jest.mocked(publisher.enqueueUsage).mock.calls[0][0];
      expect(enqueueVercelUsage).toHaveBeenCalledWith(payload);
      if (accepted) publication.resolve({ kind: 'accepted' });
      else publication.resolve({ kind: 'unavailable', reason: 'publish_failed' });
      await drain;
      expect(result).toEqual(
        accepted ? expect.objectContaining({ status: 'queued', usageId: payload.core.id }) : null
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(lifecycle.errors).toEqual([]);
      expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain(
        'synthetic-secret'
      );
    }
  );
});

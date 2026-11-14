import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { exa_monthly_usage, exa_usage_log, kilocode_users } from '@kilocode/db/schema';
import { EXA_USAGE_WRITE_PATH, ExaUsageQueueMessageSchema } from '@kilocode/usage-contracts';

let afterCallbacks: (() => Promise<void>)[] = [];

jest.mock('next/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('next/server'),
  after: (callback: () => Promise<void>) => {
    afterCallbacks.push(callback);
  },
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  EXA_API_KEY: 'synthetic-exa-key',
  EXA_USAGE_QUEUE_FALLBACK_ENABLED: true,
  USAGE_INGEST_URL: 'https://ingest.synthetic.invalid/usage',
  USAGE_INGEST_PUBLISH_SECRET: 'synthetic-publish-secret',
}));
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/organizations/organization-usage'),
  getBalanceAndOrgSettings: jest.fn(),
}));
jest.mock('@/lib/exa-usage', () => {
  const actual = jest.requireActual<typeof ExaUsageModule>('@/lib/exa-usage');
  return {
    ...actual,
    getExaMonthlyUsage: jest.fn(),
    recordExaUsage: jest.fn(actual.recordExaUsage),
  };
});
jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureException: jest.fn(),
}));

import type * as ExaUsageModule from '@/lib/exa-usage';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getExaMonthlyUsage, recordExaUsage } from '@/lib/exa-usage';
import { POST as proxyExaRoute } from '@/app/api/exa/[...path]/route';
import { POST as writeExaUsageRoute } from '@/app/api/internal/exa-usage/record/route';

const EXA_UPSTREAM_URL = 'https://api.exa.ai/search';
const INGEST_URL = 'https://ingest.synthetic.invalid/exa-usage';
const WRITER_ORIGIN = 'https://app.synthetic.invalid';
const EXA_WRITER_URL = `${WRITER_ORIGIN}${EXA_USAGE_WRITE_PATH}`;
const FREE_ALLOWANCE_MICRODOLLARS = 10_000_000;
const COST_MICRODOLLARS = 7_000;

type QueueMessage = {
  id: string;
  timestamp: Date;
  body: unknown;
  attempts: number;
  ack: jest.Mock;
  retry: jest.Mock;
};

// Load the actual Worker handlers without importing their runtime globals into the Next.js typecheck.
const { handleFetch } = jest.requireActual<{
  handleFetch: (
    request: Request,
    env: {
      USAGE_INGEST_PUBLISH_SECRET: string;
      USAGE_INGEST_QUEUE: { send: (message: unknown) => Promise<void> };
    }
  ) => Promise<Response>;
}>('../../../../services/usage-ingest/src/publish-usage');
const { handleQueue } = jest.requireActual<{
  handleQueue: (
    batch: { queue: string; messages: QueueMessage[]; ackAll: jest.Mock; retryAll: jest.Mock },
    env: { USAGE_WRITER_URL: string; USAGE_WRITER_SECRET: string | undefined }
  ) => Promise<void>;
}>('../../../../services/usage-ingest/src/consume-usage');

const mockedRecordExaUsage = jest.mocked(recordExaUsage);
const actualRecordExaUsage =
  jest.requireActual<typeof ExaUsageModule>('@/lib/exa-usage').recordExaUsage;
const queued: unknown[] = [];
const requestedUrls: string[] = [];

async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  requestedUrls.push(url);
  if (url === EXA_UPSTREAM_URL) {
    return Response.json({ results: [], costDollars: { total: COST_MICRODOLLARS / 1_000_000 } });
  }
  if (url === INGEST_URL) {
    return handleFetch(new Request(url, init), {
      USAGE_INGEST_PUBLISH_SECRET: 'synthetic-publish-secret',
      USAGE_INGEST_QUEUE: {
        send: async message => {
          queued.push(message);
        },
      },
    });
  }
  if (url === EXA_WRITER_URL) {
    return writeExaUsageRoute(new NextRequest(new Request(url, init)));
  }
  throw new TypeError('unexpected fetch target');
}

async function accountingState(userId: string) {
  const logRows = await db
    .select({ id: exa_usage_log.id })
    .from(exa_usage_log)
    .where(eq(exa_usage_log.kilo_user_id, userId));
  const counters = await db
    .select({
      requestCount: exa_monthly_usage.request_count,
      totalChargedMicrodollars: exa_monthly_usage.total_charged_microdollars,
    })
    .from(exa_monthly_usage)
    .where(eq(exa_monthly_usage.kilo_user_id, userId));
  const [user] = await db
    .select({ microdollarsUsed: kilocode_users.microdollars_used })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId));
  return { logRows, counters, microdollarsUsed: user?.microdollarsUsed };
}

beforeEach(() => {
  afterCallbacks = [];
  queued.length = 0;
  requestedUrls.length = 0;
  jest.spyOn(globalThis, 'fetch').mockImplementation(routeFetch);
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.mocked(getExaMonthlyUsage).mockResolvedValue({
    usage: FREE_ALLOWANCE_MICRODOLLARS,
    freeAllowance: FREE_ALLOWANCE_MICRODOLLARS,
  });
  jest
    .mocked(getBalanceAndOrgSettings)
    .mockResolvedValue({ balance: 5 } as Awaited<ReturnType<typeof getBalanceAndOrgSettings>>);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Exa usage fallback through the usage queue', () => {
  it('reconciles a direct write that committed and then threw with its queued copy', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const user = await insertTestUser();
    jest.mocked(getUserFromAuth).mockResolvedValue({
      user,
      authFailedResponse: null,
      organizationId: undefined,
    } as Awaited<ReturnType<typeof getUserFromAuth>>);
    mockedRecordExaUsage.mockImplementationOnce(async record => {
      await actualRecordExaUsage(record);
      throw new Error('connection lost after commit');
    });
    const before = await accountingState(user.id);

    const response = await proxyExaRoute(
      new NextRequest(
        new Request('https://app.synthetic.invalid/api/exa/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'synthetic query' }),
        })
      )
    );
    expect(response.status).toBe(200);
    for (const callback of afterCallbacks) await callback();

    expect(requestedUrls).toEqual([EXA_UPSTREAM_URL, INGEST_URL]);
    expect(queued).toHaveLength(1);
    const directRecord = mockedRecordExaUsage.mock.calls[0][0];
    const message = ExaUsageQueueMessageSchema.parse(queued[0]);
    expect(message.record).toStrictEqual(directRecord);
    expect(consoleError).toHaveBeenCalledWith(
      '[exa] usage record failed; charge may be unrecorded',
      expect.objectContaining({ stage: 'record_write', fallback: 'queued' })
    );

    const delivery: QueueMessage = {
      id: 'synthetic-queue-message',
      timestamp: new Date(),
      body: queued[0],
      attempts: 1,
      ack: jest.fn(),
      retry: jest.fn(),
    };
    await handleQueue(
      {
        queue: 'usage-ingest-processing-eu',
        messages: [delivery],
        ackAll: jest.fn(),
        retryAll: jest.fn(),
      },
      {
        USAGE_WRITER_URL: `${WRITER_ORIGIN}/api/internal/usage/record`,
        USAGE_WRITER_SECRET: INTERNAL_API_SECRET,
      }
    );

    expect(requestedUrls).toEqual([EXA_UPSTREAM_URL, INGEST_URL, EXA_WRITER_URL]);
    expect(delivery.ack).toHaveBeenCalledTimes(1);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(mockedRecordExaUsage).toHaveBeenCalledTimes(2);
    expect(mockedRecordExaUsage.mock.calls[1][0]).toStrictEqual(directRecord);
    await expect(mockedRecordExaUsage.mock.results[1].value).resolves.toBe('duplicate');

    const after = await accountingState(user.id);
    expect(after.logRows).toEqual([{ id: directRecord.id }]);
    expect(after.counters).toEqual([
      { requestCount: 1, totalChargedMicrodollars: COST_MICRODOLLARS },
    ]);
    expect(after.microdollarsUsed).toBe((before.microdollarsUsed ?? 0) + COST_MICRODOLLARS);
  });
});

import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { NextRequest } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { exa_monthly_usage, exa_usage_log, organizations } from '@kilocode/db/schema';
import { EXA_USAGE_WRITE_PATH, ExaUsageRecordSchema } from '@kilocode/usage-contracts';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { scheduleOrganizationLowBalanceAlert } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { POST as writeQueuedExaUsage } from '@/app/api/internal/exa-usage/record/route';

let afterCallbacks: (() => Promise<void>)[] = [];

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: (fn: () => Promise<void>) => {
    afterCallbacks.push(fn);
  },
}));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/config.server') as Record<string, unknown>),
  EXA_API_KEY: 'test-exa-key',
  EXA_USAGE_QUEUE_FALLBACK: 'true',
  EXA_USAGE_INGEST_URL: 'https://ingest.example.test/exa-usage',
  EXA_USAGE_INGEST_PUBLISH_SECRET: 'synthetic-exa-publisher',
}));

jest.mock('@kilocode/web-shared/lib/user/server');

jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/organizations/organization-usage') as Record<
    string,
    unknown
  >),
  scheduleOrganizationLowBalanceAlert: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  ...(jest.requireActual('@sentry/nextjs') as Record<string, unknown>),
  captureException: jest.fn(),
}));

const FREE_ALLOWANCE_MICRODOLLARS = 10_000_000;
const INGEST_URL = 'https://ingest.example.test/exa-usage';
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;

async function organizationDebit(organizationId: string) {
  const [row] = await db
    .select({ microdollars_used: organizations.microdollars_used })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row.microdollars_used;
}

describe('Exa fallback after an ambiguous post-commit failure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    afterCallbacks = [];
    globalThis.fetch = mockedFetch;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('queues the same record, and its delivery is a duplicate with one debit', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization(
      `exa-fallback-${crypto.randomUUID()}`,
      user.id,
      50_000
    );
    await db.insert(exa_monthly_usage).values({
      kilo_user_id: user.id,
      organization_id: organization.id,
      month: sql`date_trunc('month', now())::date`.mapWith(String),
      total_cost_microdollars: FREE_ALLOWANCE_MICRODOLLARS,
      total_charged_microdollars: 0,
      request_count: 1,
      free_allowance_microdollars: FREE_ALLOWANCE_MICRODOLLARS,
    });
    jest.mocked(getUserFromAuth).mockResolvedValue({
      user,
      authFailedResponse: null,
      organizationId: organization.id,
    });
    jest.mocked(scheduleOrganizationLowBalanceAlert).mockImplementation(() => {
      throw new Error('post-commit alert scheduling failed');
    });
    mockedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [], costDollars: { total: 0.009 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost:3000/api/exa/contents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'replay' }),
      }) as never
    );
    expect(response.status).toBe(200);
    for (const fn of afterCallbacks.splice(0)) await fn();

    expect(scheduleOrganizationLowBalanceAlert).toHaveBeenCalledTimes(1);
    expect(await organizationDebit(organization.id)).toBe(9000);
    const publishes = mockedFetch.mock.calls.filter(([url]) => url === INGEST_URL);
    expect(publishes).toHaveLength(1);
    const queued = ExaUsageRecordSchema.parse(JSON.parse(publishes[0][1]?.body as string));
    expect(queued).toMatchObject({
      organizationId: organization.id,
      costMicrodollars: 9000,
      chargedToBalance: true,
    });

    const delivery = await writeQueuedExaUsage(
      new NextRequest(`http://localhost${EXA_USAGE_WRITE_PATH}`, {
        method: 'POST',
        headers: { 'x-internal-api-key': INTERNAL_API_SECRET, 'x-usage-write-source': 'queue' },
        body: JSON.stringify(queued),
      })
    );
    expect(delivery.status).toBe(200);
    await expect(delivery.json()).resolves.toEqual({ status: 'duplicate', usageId: queued.id });

    expect(await organizationDebit(organization.id)).toBe(9000);
    const logRows = await db.select().from(exa_usage_log).where(eq(exa_usage_log.id, queued.id));
    expect(logRows).toHaveLength(1);
    const [counter] = await db
      .select()
      .from(exa_monthly_usage)
      .where(
        and(
          eq(exa_monthly_usage.kilo_user_id, user.id),
          eq(exa_monthly_usage.organization_id, organization.id)
        )
      );
    expect(counter).toMatchObject({
      request_count: 2,
      total_cost_microdollars: FREE_ALLOWANCE_MICRODOLLARS + 9000,
      total_charged_microdollars: 9000,
    });
  });
});

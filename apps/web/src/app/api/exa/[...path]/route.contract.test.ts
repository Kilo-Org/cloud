import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  exa_monthly_usage,
  exa_usage_log,
  kilocode_users,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { ExaUsageRecordSchema, type ExaUsageRecord } from '@kilocode/usage-contracts';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { captureException } from '@sentry/nextjs';
import { recordExaUsage } from '@/lib/exa-usage';

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
}));

jest.mock('@kilocode/web-shared/lib/user/server');

jest.mock('@/lib/exa-usage', () => {
  const actual = jest.requireActual<{ recordExaUsage: typeof recordExaUsage }>('@/lib/exa-usage');
  return { ...actual, recordExaUsage: jest.fn(actual.recordExaUsage) };
});

jest.mock('@sentry/nextjs', () => ({
  ...(jest.requireActual('@sentry/nextjs') as Record<string, unknown>),
  captureException: jest.fn(),
}));

const FREE_ALLOWANCE_MICRODOLLARS = 10_000_000;

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedRecordExaUsage = jest.mocked(recordExaUsage);
const mockedCaptureException = jest.mocked(captureException);
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;

async function flushAfterCallbacks() {
  const callbacks = afterCallbacks.splice(0);
  for (const fn of callbacks) {
    await fn();
  }
}

async function exhaustFreeAllowance(userId: string) {
  await db.insert(exa_monthly_usage).values({
    kilo_user_id: userId,
    month: sql`date_trunc('month', now())::date`.mapWith(String),
    total_cost_microdollars: FREE_ALLOWANCE_MICRODOLLARS,
    total_charged_microdollars: 0,
    request_count: 1,
    free_allowance_microdollars: FREE_ALLOWANCE_MICRODOLLARS,
  });
}

async function callRoute(user: User, organizationId: string | undefined, path: string) {
  mockedGetUserFromAuth.mockResolvedValue({ user, authFailedResponse: null, organizationId });
  mockedFetch.mockResolvedValue(
    new Response(JSON.stringify({ results: [], costDollars: { total: 0.009 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );

  const { POST } = await import('./route');
  const response = await POST(
    new Request(`http://localhost:3000/api/exa${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-kilocode-feature': 'kiloclaw' },
      body: JSON.stringify({ query: 'contract', type: 'deep' }),
    }) as never
  );
  expect(response.status).toBe(200);
  await flushAfterCallbacks();

  expect(mockedCaptureException).not.toHaveBeenCalled();
  expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
  const [[record]] = mockedRecordExaUsage.mock.calls;
  await expect(mockedRecordExaUsage.mock.results[0].value).resolves.toBe('recorded');
  return record;
}

function expectRecordSurvivesTheWire(record: ExaUsageRecord) {
  expect(ExaUsageRecordSchema.parse(record)).toStrictEqual(record);
  const wireCopy: unknown = JSON.parse(JSON.stringify(record));
  expect(wireCopy).toStrictEqual(record);
  expect(ExaUsageRecordSchema.parse(wireCopy)).toStrictEqual(record);
}

async function readUsageLogRow(record: ExaUsageRecord) {
  const rows = await db
    .select()
    .from(exa_usage_log)
    .where(eq(exa_usage_log.kilo_user_id, record.userId));
  expect(rows).toHaveLength(1);
  const [row] = rows;
  return {
    id: row.id,
    occurredAt: new Date(row.created_at).toISOString(),
    userId: row.kilo_user_id,
    organizationId: row.organization_id,
    path: row.path,
    costMicrodollars: row.cost_microdollars,
    chargedToBalance: row.charged_to_balance,
    featureId: row.feature_id,
    type: row.type,
  };
}

describe('Exa usage record across route, contract and writer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    afterCallbacks = [];
    globalThis.fetch = mockedFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('carries a charged personal record unchanged into the database', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 100_000_000,
    });
    await exhaustFreeAllowance(user.id);

    const record = await callRoute(user, undefined, '/search');

    expect(record).toStrictEqual({
      id: expect.any(String),
      occurredAt: expect.any(String),
      userId: user.id,
      organizationId: null,
      path: '/search',
      costMicrodollars: 9000,
      chargedToBalance: true,
      freeAllowanceMicrodollars: FREE_ALLOWANCE_MICRODOLLARS,
      featureId: 'kiloclaw',
      type: 'deep',
    });
    expectRecordSurvivesTheWire(record);

    expect(await readUsageLogRow(record)).toStrictEqual({
      id: record.id,
      occurredAt: record.occurredAt,
      userId: record.userId,
      organizationId: null,
      path: record.path,
      costMicrodollars: record.costMicrodollars,
      chargedToBalance: true,
      featureId: 'kiloclaw',
      type: 'deep',
    });

    const [personalCounter] = await db
      .select()
      .from(exa_monthly_usage)
      .where(
        and(eq(exa_monthly_usage.kilo_user_id, user.id), isNull(exa_monthly_usage.organization_id))
      );
    expect(personalCounter).toMatchObject({
      total_cost_microdollars: FREE_ALLOWANCE_MICRODOLLARS + record.costMicrodollars,
      total_charged_microdollars: record.costMicrodollars,
      request_count: 2,
    });

    const [charged] = await db
      .select({ microdollars_used: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(charged.microdollars_used).toBe(record.costMicrodollars);

    const wireCopy = ExaUsageRecordSchema.parse(JSON.parse(JSON.stringify(record)));
    await expect(recordExaUsage(wireCopy)).resolves.toBe('duplicate');
    const [afterReplay] = await db
      .select({ microdollars_used: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(afterReplay.microdollars_used).toBe(record.costMicrodollars);
  });

  it('carries a charged organization record unchanged into the database', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization(
      `exa-contract-${crypto.randomUUID()}`,
      user.id,
      50_000
    );
    await exhaustFreeAllowance(user.id);

    const record = await callRoute(user, organization.id, '/contents');

    expect(record).toStrictEqual({
      id: expect.any(String),
      occurredAt: expect.any(String),
      userId: user.id,
      organizationId: organization.id,
      path: '/contents',
      costMicrodollars: 9000,
      chargedToBalance: true,
      freeAllowanceMicrodollars: FREE_ALLOWANCE_MICRODOLLARS,
      featureId: 'kiloclaw',
      type: 'deep',
    });
    expectRecordSurvivesTheWire(record);

    expect(await readUsageLogRow(record)).toStrictEqual({
      id: record.id,
      occurredAt: record.occurredAt,
      userId: record.userId,
      organizationId: organization.id,
      path: record.path,
      costMicrodollars: record.costMicrodollars,
      chargedToBalance: true,
      featureId: 'kiloclaw',
      type: 'deep',
    });

    const [organizationCounter] = await db
      .select()
      .from(exa_monthly_usage)
      .where(eq(exa_monthly_usage.organization_id, organization.id));
    expect(organizationCounter).toMatchObject({
      kilo_user_id: user.id,
      total_cost_microdollars: record.costMicrodollars,
      total_charged_microdollars: record.costMicrodollars,
      request_count: 1,
    });

    const [chargedOrganization] = await db
      .select({ microdollars_used: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    expect(chargedOrganization.microdollars_used).toBe(record.costMicrodollars);

    const [personal] = await db
      .select({ microdollars_used: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(personal.microdollars_used).toBe(0);

    const wireCopy = ExaUsageRecordSchema.parse(JSON.parse(JSON.stringify(record)));
    await expect(recordExaUsage(wireCopy)).resolves.toBe('duplicate');
    const [afterReplay] = await db
      .select({ microdollars_used: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    expect(afterReplay.microdollars_used).toBe(record.costMicrodollars);
  });

  it('carries a free personal record unchanged without a balance debit', async () => {
    const user = await insertTestUser({ microdollars_used: 0 });

    const record = await callRoute(user, undefined, '/answer');

    expect(record).toMatchObject({
      organizationId: null,
      chargedToBalance: false,
      costMicrodollars: 9000,
    });
    expectRecordSurvivesTheWire(record);
    expect(await readUsageLogRow(record)).toMatchObject({
      id: record.id,
      occurredAt: record.occurredAt,
      organizationId: null,
      chargedToBalance: false,
      costMicrodollars: record.costMicrodollars,
    });

    const [uncharged] = await db
      .select({ microdollars_used: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(uncharged.microdollars_used).toBe(0);
  });
});

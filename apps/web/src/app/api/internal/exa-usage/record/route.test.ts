import { afterEach, describe, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { EXA_USAGE_WRITE_PATH, type ExaUsageRecord } from '@kilocode/usage-contracts';
import {
  exa_monthly_usage,
  exa_usage_log,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { queueWriterAdmission } from '@kilocode/web-shared/lib/ai-gateway/usage-writer-admission';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { POST } from './route';

const authorized = { 'x-internal-api-key': INTERNAL_API_SECRET };
const fromQueue = { ...authorized, 'x-usage-write-source': 'queue' };

afterEach(() => {
  jest.restoreAllMocks();
});

function request(body: unknown, headers: Record<string, string> = authorized) {
  return new NextRequest(`http://localhost${EXA_USAGE_WRITE_PATH}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function post(body: unknown, headers: Record<string, string> = authorized) {
  return POST(request(body, headers));
}

async function personalRecord(): Promise<ExaUsageRecord> {
  const user = await insertTestUser({
    microdollars_used: 0,
    total_microdollars_acquired: 100_000_000,
  });
  return {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    userId: user.id,
    organizationId: null,
    path: '/search',
    costMicrodollars: 7000,
    chargedToBalance: true,
    freeAllowanceMicrodollars: 10_000_000,
    featureId: 'kiloclaw',
    type: 'deep',
  };
}

async function organizationRecord(): Promise<ExaUsageRecord> {
  const user = await insertTestUser();
  const organization = await createTestOrganization(`exa-writer-${randomUUID()}`, user.id, 50_000);
  return {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    userId: user.id,
    organizationId: organization.id,
    path: '/contents',
    costMicrodollars: 9000,
    chargedToBalance: true,
    freeAllowanceMicrodollars: 10_000_000,
  };
}

async function logRows(userId: string) {
  return db.select().from(exa_usage_log).where(eq(exa_usage_log.kilo_user_id, userId));
}

async function monthlyRows(userId: string) {
  return db.select().from(exa_monthly_usage).where(eq(exa_monthly_usage.kilo_user_id, userId));
}

async function debitedMicrodollars(record: ExaUsageRecord) {
  if (record.organizationId) {
    const [row] = await db
      .select({ used: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, record.organizationId));
    return row?.used;
  }
  const [row] = await db
    .select({ used: kilocode_users.microdollars_used })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, record.userId));
  return row?.used;
}

function heldWrite() {
  const settle = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const transaction = db.transaction.bind(db);
  jest.spyOn(db, 'transaction').mockImplementationOnce(async (...args) => {
    started.resolve();
    await settle.promise;
    return transaction(...args);
  });
  return { started: started.promise, settle: settle.resolve };
}

describe(`POST ${EXA_USAGE_WRITE_PATH}`, () => {
  test.each([
    ['no secret', {}],
    ['a wrong secret', { 'x-internal-api-key': `${INTERNAL_API_SECRET}-wrong` }],
  ])('rejects a request with %s before reading the body', async (_name, headers) => {
    const record = await personalRecord();
    const unauthorized = request(record, headers);
    const readBody = jest.spyOn(unauthorized, 'json');

    const response = await POST(unauthorized);

    expect(response.status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();
    expect(await logRows(record.userId)).toEqual([]);
  });

  test.each([
    ['a body that is not JSON', () => 'not json secret text'],
    ['a non-UUID id', (record: ExaUsageRecord) => ({ ...record, id: 'usage-1' })],
    ['a non-ISO occurredAt', (record: ExaUsageRecord) => ({ ...record, occurredAt: 'yesterday' })],
    [
      'a non-UUID organization id',
      (record: ExaUsageRecord) => ({ ...record, organizationId: 'secret text' }),
    ],
    [
      'a missing field',
      ({ costMicrodollars: _costMicrodollars, ...record }: ExaUsageRecord) => record,
    ],
    ['an unexpected field', (record: ExaUsageRecord) => ({ ...record, prompt: 'secret text' })],
  ])('rejects %s with 400, a bounded log and no write', async (_name, makeBody) => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const record = await personalRecord();

    const response = await post(makeBody(record));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid body' });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain('secret text');
    expect(logged).not.toContain(record.userId);
    expect(await logRows(record.userId)).toEqual([]);
  });

  test.each([
    [
      'logs only the class of a JSON syntax error, whose message quotes the body',
      new SyntaxError('Unexpected token, "secret text" is not valid JSON'),
      { error_name: 'SyntaxError' },
    ],
    [
      'logs the class and message of a body stream failure',
      new TypeError('Body is unusable'),
      { error_name: 'TypeError', error_message: 'Body is unusable' },
    ],
  ])('%s and returns 400', async (_name, failure, expectedLog) => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const record = await personalRecord();
    const unreadable = request(record);
    jest.spyOn(unreadable, 'json').mockRejectedValueOnce(failure);

    const response = await POST(unreadable);

    expect(response.status).toBe(400);
    expect(consoleError).toHaveBeenCalledWith(
      '[exa-usage] usage record request body could not be read as JSON',
      expectedLog
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret text');
    expect(await logRows(record.userId)).toEqual([]);
  });

  test.each([
    ['personal', personalRecord, 7000],
    ['organization', organizationRecord, 9000],
  ])(
    'records a %s charge once and reports the replay as a duplicate',
    async (_payer, makeRecord, cost) => {
      const record = await makeRecord();

      const first = await post(record);
      const second = await post(record);

      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toEqual({ status: 'recorded', usageId: record.id });
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toEqual({ status: 'duplicate', usageId: record.id });
      expect(await logRows(record.userId)).toEqual([
        expect.objectContaining({
          id: record.id,
          organization_id: record.organizationId,
          path: record.path,
          cost_microdollars: cost,
          charged_to_balance: true,
          feature_id: record.featureId ?? null,
          type: record.type ?? null,
        }),
      ]);
      expect(await monthlyRows(record.userId)).toEqual([
        expect.objectContaining({
          total_cost_microdollars: cost,
          total_charged_microdollars: cost,
          request_count: 1,
        }),
      ]);
      expect(await debitedMicrodollars(record)).toBe(cost);
    }
  );

  test('returns the overload body for a queue write when admission is full, without writing', async () => {
    const record = await personalRecord();
    const acquire = jest
      .spyOn(queueWriterAdmission, 'acquire')
      .mockResolvedValueOnce({ admitted: false, reason: 'queue_limit' });
    const transaction = jest.spyOn(db, 'transaction');

    const response = await post(record, fromQueue);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: 'Usage writer overloaded',
      reason: 'queue_limit',
    });
    expect(acquire).toHaveBeenCalledWith('queue', record.id, {
      maxWaitMs: 250,
      signal: expect.any(AbortSignal),
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(await logRows(record.userId)).toEqual([]);
  });

  test('keeps the admission slot until a queue write commits', async () => {
    const record = await personalRecord();
    const release = jest.fn();
    jest.spyOn(queueWriterAdmission, 'acquire').mockResolvedValueOnce({ admitted: true, release });
    const write = heldWrite();

    const pending = post(record, fromQueue);
    await write.started;
    expect(release).not.toHaveBeenCalled();
    write.settle();
    const response = await pending;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'recorded', usageId: record.id });
    expect(release).toHaveBeenCalledTimes(1);
    expect(await logRows(record.userId)).toHaveLength(1);
  });

  test('releases the admission slot after a failed queue write and logs only the usage id', async () => {
    const record = await personalRecord();
    const release = jest.fn();
    jest.spyOn(queueWriterAdmission, 'acquire').mockResolvedValueOnce({ admitted: true, release });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(db, 'transaction').mockRejectedValueOnce(
      Object.assign(new Error(`Failed query: insert ... params: ${record.userId}`), {
        cause: Object.assign(new Error('violates foreign key'), {
          code: '23503',
          constraint: 'fk_test',
        }),
      })
    );

    const response = await post(record, fromQueue);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Usage write failed' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[exa-usage] failed to record usage in the primary region',
      {
        usage_id: record.id,
        error: expect.objectContaining({ code: '23503', constraint: 'fk_test' }),
      }
    );
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain(record.userId);
    expect(logged).not.toContain(INTERNAL_API_SECRET);
  });

  test.each([undefined, 'queue_vercel', 'region_handoff', 'QUEUE'])(
    'writes source %s without taking queue admission',
    async source => {
      const record = await personalRecord();
      const acquire = jest.spyOn(queueWriterAdmission, 'acquire');

      const response = await post(
        record,
        source === undefined ? authorized : { ...authorized, 'x-usage-write-source': source }
      );

      expect(response.status).toBe(200);
      expect(acquire).not.toHaveBeenCalled();
      expect(await logRows(record.userId)).toHaveLength(1);
    }
  );
});

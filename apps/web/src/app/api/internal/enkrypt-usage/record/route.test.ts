import { afterEach, describe, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { enkrypt_usage, enkrypt_usage_guardrail, organizations } from '@kilocode/db/schema';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { queueWriterAdmission } from '@kilocode/web-shared/lib/ai-gateway/usage-writer-admission';
import { MICRODOLLARS_PER_ENKRYPT_CREDIT } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import { recordEnkryptUsageInPrimaryRegion } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-primary-region';
import {
  MAX_ENKRYPT_CREDITS_PER_CALL,
  type EnkryptUsageWrite,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-write';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { POST } from './route';

const nativeFetch = globalThis.fetch;
const authorized = { 'x-internal-api-key': INTERNAL_API_SECRET };
const fromQueue = { ...authorized, 'x-usage-write-source': 'queue' };

afterEach(() => {
  globalThis.fetch = nativeFetch;
  jest.restoreAllMocks();
});

async function usageWriteForNewOrganization(): Promise<EnkryptUsageWrite> {
  const user = await insertTestUser();
  const organization = await createTestOrganization(
    `enkrypt-guardrail-${randomUUID()}`,
    user.id,
    10_000_000
  );
  return {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    organizationId: organization.id,
    kiloUserId: user.id,
    sessionId: 'ses_guardrail',
    microdollarUsageId: randomUUID(),
    apiKind: 'messages',
    decision: 'blocked',
    creditsCost: 7,
    addedLatencyMs: 212,
    guardrail: 'output',
  };
}

function post(body: unknown, headers: Record<string, string> = authorized) {
  return POST(
    new NextRequest('http://localhost/api/internal/enkrypt-usage/record', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

async function ledgerRows(organizationId: string) {
  const rows = await db
    .select({ row: enkrypt_usage, guardrail: enkrypt_usage_guardrail.guardrail })
    .from(enkrypt_usage)
    .leftJoin(
      enkrypt_usage_guardrail,
      eq(enkrypt_usage_guardrail.guardrail_id, enkrypt_usage.guardrail_id)
    )
    .where(eq(enkrypt_usage.organization_id, organizationId));
  return rows.map(({ row, guardrail }) => ({ ...row, guardrail }));
}

async function microdollarsUsed(organizationId: string) {
  const [row] = await db
    .select({ microdollarsUsed: organizations.microdollars_used })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.microdollarsUsed;
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

describe('POST /api/internal/enkrypt-usage/record', () => {
  test.each([
    ['no secret', {}],
    ['a wrong secret', { 'x-internal-api-key': `${INTERNAL_API_SECRET}-wrong` }],
  ])('rejects a request with %s', async (_name, headers) => {
    const usageWrite = await usageWriteForNewOrganization();

    const response = await post(usageWrite, headers);

    expect(response.status).toBe(401);
    expect(await ledgerRows(usageWrite.organizationId)).toEqual([]);
  });

  test.each([
    ['a body that is not JSON', () => 'not json'],
    ['a non-UUID id', (write: EnkryptUsageWrite) => ({ ...write, id: 'usage-1' })],
    [
      'a non-UUID inference usage id',
      (write: EnkryptUsageWrite) => ({ ...write, microdollarUsageId: 'usage-1' }),
    ],
    ['an unknown decision', (write: EnkryptUsageWrite) => ({ ...write, decision: 'maybe' })],
    ['an unknown guardrail', (write: EnkryptUsageWrite) => ({ ...write, guardrail: 'both' })],
    ['negative credits', (write: EnkryptUsageWrite) => ({ ...write, creditsCost: -1 })],
    [
      'credits above the per-call maximum',
      (write: EnkryptUsageWrite) => ({ ...write, creditsCost: MAX_ENKRYPT_CREDITS_PER_CALL + 1 }),
    ],
    ['a missing field', ({ creditsCost: _creditsCost, ...write }: EnkryptUsageWrite) => write],
    ['an unexpected field', (write: EnkryptUsageWrite) => ({ ...write, prompt: 'secret text' })],
  ])('rejects %s without writing', async (_name, makeBody) => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const usageWrite = await usageWriteForNewOrganization();

    const response = await post(makeBody(usageWrite));

    expect(response.status).toBe(400);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret text');
    expect(await ledgerRows(usageWrite.organizationId)).toEqual([]);
  });

  test('logs a body that cannot be read as JSON without its contents', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await post('{"prompt": "secret text"');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid body' });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[enkrypt-guardrail] usage handoff request body could not be read as JSON',
      { error_name: expect.any(String) }
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret text');
  });

  test('logs only the error name when reading the body throws a SyntaxError', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const unreadable = new NextRequest('http://localhost/api/internal/enkrypt-usage/record', {
      method: 'POST',
      headers: authorized,
      body: '{}',
    });
    jest
      .spyOn(unreadable, 'json')
      .mockRejectedValueOnce(new SyntaxError('Unexpected token in JSON: secret text'));

    const response = await POST(unreadable);

    expect(response.status).toBe(400);
    expect(consoleError).toHaveBeenCalledWith(
      '[enkrypt-guardrail] usage handoff request body could not be read as JSON',
      { error_name: 'SyntaxError' }
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret text');
  });

  test('records the usage once and reports a redelivery as a duplicate', async () => {
    const usageWrite = await usageWriteForNewOrganization();

    const first = await post(usageWrite);
    const second = await post(usageWrite);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'recorded', usageId: usageWrite.id });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'duplicate', usageId: usageWrite.id });
    expect(await ledgerRows(usageWrite.organizationId)).toEqual([
      expect.objectContaining({
        id: usageWrite.id,
        kilo_user_id: usageWrite.kiloUserId,
        session_id: 'ses_guardrail',
        microdollar_usage_id: usageWrite.microdollarUsageId,
        enkrypt_credits_cost: 7,
        charged_microdollars: 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
        added_latency_ms: 212,
        guardrail: 'output',
      }),
    ]);
    expect(await microdollarsUsed(usageWrite.organizationId)).toBe(
      7 * MICRODOLLARS_PER_ENKRYPT_CREDIT
    );
  });

  test('records a legacy input call without an inference association', async () => {
    const {
      guardrail: _guardrail,
      microdollarUsageId: _microdollarUsageId,
      ...usageWrite
    } = await usageWriteForNewOrganization();

    const response = await post(usageWrite);

    expect(response.status).toBe(200);
    expect(await ledgerRows(usageWrite.organizationId)).toEqual([
      expect.objectContaining({
        id: usageWrite.id,
        guardrail: 'input',
        microdollar_usage_id: null,
      }),
    ]);
  });

  test('reports a failed write without logging query parameters', async () => {
    const usageWrite = await usageWriteForNewOrganization();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(db, 'transaction').mockRejectedValueOnce(
      Object.assign(new Error(`Failed query: insert ... params: ${usageWrite.kiloUserId}`), {
        cause: Object.assign(new Error('violates foreign key'), {
          code: '23503',
          constraint: 'fk_test',
        }),
      })
    );

    const response = await post(usageWrite);

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      '[enkrypt-guardrail] failed to record usage in the primary region',
      {
        usage_id: usageWrite.id,
        error: expect.objectContaining({ code: '23503', constraint: 'fk_test' }),
      }
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(usageWrite.kiloUserId);
  });

  test('accepts a handoff from recordEnkryptUsageInPrimaryRegion without taking queue admission', async () => {
    const usageWrite = await usageWriteForNewOrganization();
    const acquire = jest.spyOn(queueWriterAdmission, 'acquire');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = async (input, init) => POST(new NextRequest(new Request(input, init)));

    expect(await recordEnkryptUsageInPrimaryRegion(usageWrite)).toBe(true);

    expect(acquire).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(await ledgerRows(usageWrite.organizationId)).toHaveLength(1);
  });

  test('returns the overload body for a queue write when admission is full, without writing', async () => {
    const usageWrite = await usageWriteForNewOrganization();
    const acquire = jest
      .spyOn(queueWriterAdmission, 'acquire')
      .mockResolvedValueOnce({ admitted: false, reason: 'queue_limit' });
    const transaction = jest.spyOn(db, 'transaction');

    const response = await post(usageWrite, fromQueue);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'Usage writer overloaded',
      reason: 'queue_limit',
    });
    expect(acquire).toHaveBeenCalledWith('queue', usageWrite.id, {
      maxWaitMs: 250,
      signal: expect.any(AbortSignal),
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(await ledgerRows(usageWrite.organizationId)).toEqual([]);
    expect(await microdollarsUsed(usageWrite.organizationId)).toBe(0);
  });

  test('keeps the admission slot until a queue write commits', async () => {
    const usageWrite = await usageWriteForNewOrganization();
    const release = jest.fn();
    jest.spyOn(queueWriterAdmission, 'acquire').mockResolvedValueOnce({ admitted: true, release });
    const write = heldWrite();

    const pending = post(usageWrite, fromQueue);
    await write.started;
    expect(release).not.toHaveBeenCalled();
    write.settle();
    const response = await pending;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'recorded', usageId: usageWrite.id });
    expect(release).toHaveBeenCalledTimes(1);
    expect(await ledgerRows(usageWrite.organizationId)).toHaveLength(1);
  });

  test('releases the admission slot after a failed queue write and logs only the usage id', async () => {
    const usageWrite = await usageWriteForNewOrganization();
    const release = jest.fn();
    jest.spyOn(queueWriterAdmission, 'acquire').mockResolvedValueOnce({ admitted: true, release });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(db, 'transaction').mockRejectedValueOnce(
      Object.assign(new Error(`Failed query: insert ... params: ${usageWrite.kiloUserId}`), {
        cause: Object.assign(new Error('violates foreign key'), {
          code: '23503',
          constraint: 'fk_test',
        }),
      })
    );

    const response = await post(usageWrite, fromQueue);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Usage write failed' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[enkrypt-guardrail] failed to record usage in the primary region',
      {
        usage_id: usageWrite.id,
        error: expect.objectContaining({ code: '23503', constraint: 'fk_test' }),
      }
    );
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain(usageWrite.kiloUserId);
    expect(logged).not.toContain(INTERNAL_API_SECRET);
  });

  test.each([undefined, 'queue_vercel', 'region_handoff', 'QUEUE'])(
    'writes source %s without taking queue admission',
    async source => {
      const usageWrite = await usageWriteForNewOrganization();
      const acquire = jest.spyOn(queueWriterAdmission, 'acquire');

      const response = await post(
        usageWrite,
        source === undefined ? authorized : { ...authorized, 'x-usage-write-source': source }
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'recorded', usageId: usageWrite.id });
      expect(acquire).not.toHaveBeenCalled();
      expect(await ledgerRows(usageWrite.organizationId)).toHaveLength(1);
    }
  );
});

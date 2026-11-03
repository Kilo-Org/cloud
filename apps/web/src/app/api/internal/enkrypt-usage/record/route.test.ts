import { afterEach, describe, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { enkrypt_usage, organizations } from '@kilocode/db/schema';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { MICRODOLLARS_PER_ENKRYPT_CREDIT } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import { recordEnkryptUsageInPrimaryRegion } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-primary-region';
import type { EnkryptUsageWrite } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-write';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { POST } from './route';

const nativeFetch = globalThis.fetch;

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
    apiKind: 'messages',
    decision: 'blocked',
    creditsCost: 7,
    addedLatencyMs: 212,
  };
}

function post(
  body: unknown,
  headers: Record<string, string> = { 'x-internal-api-key': INTERNAL_API_SECRET }
) {
  return POST(
    new NextRequest('http://localhost/api/internal/enkrypt-usage/record', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

async function ledgerRows(organizationId: string) {
  return db.select().from(enkrypt_usage).where(eq(enkrypt_usage.organization_id, organizationId));
}

async function microdollarsUsed(organizationId: string) {
  const [row] = await db
    .select({ microdollarsUsed: organizations.microdollars_used })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.microdollarsUsed;
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
    ['an unknown decision', (write: EnkryptUsageWrite) => ({ ...write, decision: 'maybe' })],
    ['negative credits', (write: EnkryptUsageWrite) => ({ ...write, creditsCost: -1 })],
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

  test('records the usage once and reports a redelivery as a duplicate', async () => {
    const usageWrite = await usageWriteForNewOrganization();

    const first = await post(usageWrite);
    const second = await post(usageWrite);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'recorded' });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'duplicate' });
    expect(await ledgerRows(usageWrite.organizationId)).toEqual([
      expect.objectContaining({
        id: usageWrite.id,
        kilo_user_id: usageWrite.kiloUserId,
        session_id: 'ses_guardrail',
        enkrypt_credits_cost: 7,
        charged_microdollars: 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
        added_latency_ms: 212,
      }),
    ]);
    expect(await microdollarsUsed(usageWrite.organizationId)).toBe(
      7 * MICRODOLLARS_PER_ENKRYPT_CREDIT
    );
  });

  test('accepts a handoff from recordEnkryptUsageInPrimaryRegion', async () => {
    const usageWrite = await usageWriteForNewOrganization();
    globalThis.fetch = async (input, init) => POST(new NextRequest(new Request(input, init)));

    expect(await recordEnkryptUsageInPrimaryRegion(usageWrite)).toBe(true);

    expect(await ledgerRows(usageWrite.organizationId)).toHaveLength(1);
  });
});

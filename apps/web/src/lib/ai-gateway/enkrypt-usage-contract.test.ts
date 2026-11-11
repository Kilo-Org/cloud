jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/drizzle'),
  isUSRegion: jest.fn(() => true),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-primary-region', () => ({
  recordEnkryptUsageInPrimaryRegion: jest.fn(async () => true),
}));

import { beforeEach, describe, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  enkrypt_usage,
  enkrypt_usage_detector,
  enkrypt_usage_guardrail,
  organizations,
} from '@kilocode/db/schema';
import {
  EnkryptUsageWriteSchema,
  type EnkryptUsageWrite,
  type EnkryptUsageWriteInput,
} from '@kilocode/usage-contracts';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  MICRODOLLARS_PER_ENKRYPT_CREDIT,
  recordEnkryptUsage,
  recordEnkryptUsageLocally,
  type EnkryptUsageRecord,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import { recordEnkryptUsageInPrimaryRegion } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-primary-region';
import { EnkryptUsageWriteSchema as WebSharedEnkryptUsageWriteSchema } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-write';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

const mockedHandoff = jest.mocked(recordEnkryptUsageInPrimaryRegion);

beforeEach(() => {
  mockedHandoff.mockClear();
});

async function usageRecordForNewOrganization(
  overrides: Partial<EnkryptUsageRecord> = {}
): Promise<EnkryptUsageRecord> {
  const user = await insertTestUser();
  const organization = await createTestOrganization(
    `enkrypt-contract-${randomUUID()}`,
    user.id,
    10_000_000
  );
  return {
    organizationId: organization.id,
    kiloUserId: user.id,
    sessionId: 'ses_guardrail',
    microdollarUsageId: randomUUID(),
    apiKind: 'messages',
    decision: 'blocked',
    creditsCost: 7,
    addedLatencyMs: 212,
    ...overrides,
  };
}

async function writeInputFromGateway(usageRecord: EnkryptUsageRecord) {
  await recordEnkryptUsage(usageRecord);
  expect(mockedHandoff).toHaveBeenCalledTimes(1);
  const [[writeInput]] = mockedHandoff.mock.calls;
  return writeInput;
}

function parseWireCopy(writeInput: EnkryptUsageWriteInput): EnkryptUsageWrite {
  const wireCopy: unknown = JSON.parse(JSON.stringify(writeInput));
  expect(wireCopy).toStrictEqual(writeInput);
  return EnkryptUsageWriteSchema.parse(wireCopy);
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
  const detectors = await db.select().from(enkrypt_usage_detector);
  const detectorById = new Map(detectors.map(each => [each.detector_id, each.detector]));
  return rows.map(({ row, guardrail }) => ({
    id: row.id,
    occurredAt: new Date(row.created_at).toISOString(),
    kiloUserId: row.kilo_user_id,
    sessionId: row.session_id,
    microdollarUsageId: row.microdollar_usage_id,
    creditsCost: row.enkrypt_credits_cost,
    chargedMicrodollars: row.charged_microdollars,
    addedLatencyMs: row.added_latency_ms,
    guardrail,
    detectorsFired: row.fired_detector_ids?.map(id => detectorById.get(id)) ?? null,
  }));
}

async function microdollarsUsed(organizationId: string) {
  const [row] = await db
    .select({ microdollarsUsed: organizations.microdollars_used })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.microdollarsUsed;
}

async function expectWrittenOnceAndReplayedAsDuplicate(usageWrite: EnkryptUsageWrite) {
  const charged = 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT;

  await expect(recordEnkryptUsageLocally(usageWrite)).resolves.toBe('recorded');
  const replay = EnkryptUsageWriteSchema.parse(JSON.parse(JSON.stringify(usageWrite)));
  await expect(recordEnkryptUsageLocally(replay)).resolves.toBe('duplicate');

  expect(await ledgerRows(usageWrite.organizationId)).toStrictEqual([
    {
      id: usageWrite.id,
      occurredAt: usageWrite.occurredAt,
      kiloUserId: usageWrite.kiloUserId,
      sessionId: usageWrite.sessionId,
      microdollarUsageId: usageWrite.microdollarUsageId ?? null,
      creditsCost: usageWrite.creditsCost,
      chargedMicrodollars: charged,
      addedLatencyMs: usageWrite.addedLatencyMs,
      guardrail: usageWrite.guardrail,
      detectorsFired: usageWrite.detectorsFired ?? null,
    },
  ]);
  expect(await microdollarsUsed(usageWrite.organizationId)).toBe(charged);
}

describe('Enkrypt usage write across gateway, contract and writer', () => {
  test('web-shared re-exports the contract schema', () => {
    expect(WebSharedEnkryptUsageWriteSchema).toBe(EnkryptUsageWriteSchema);
  });

  test('carries an output guardrail write unchanged into one ledger row and one debit', async () => {
    const usageRecord = await usageRecordForNewOrganization({ guardrail: 'output' });

    const writeInput = await writeInputFromGateway(usageRecord);

    expect(writeInput).toStrictEqual({
      ...usageRecord,
      id: expect.any(String),
      occurredAt: expect.any(String),
    });
    const usageWrite = parseWireCopy(writeInput);
    expect(usageWrite).toStrictEqual(writeInput);

    await expectWrittenOnceAndReplayedAsDuplicate(usageWrite);
  });

  test('carries an input guardrail write, which omits the guardrail, as input', async () => {
    const usageRecord = await usageRecordForNewOrganization();

    const writeInput = await writeInputFromGateway(usageRecord);

    expect(writeInput).not.toHaveProperty('guardrail');
    const usageWrite = parseWireCopy(writeInput);
    expect(usageWrite).toStrictEqual({ ...writeInput, guardrail: 'input' });

    await expectWrittenOnceAndReplayedAsDuplicate(usageWrite);
  });

  test('carries the detectors of a log-only detection into the ledger row', async () => {
    const usageRecord = await usageRecordForNewOrganization({
      decision: 'allowed',
      detectorsFired: ['pii', 'toxicity'],
    });

    const writeInput = await writeInputFromGateway(usageRecord);

    expect(writeInput).toStrictEqual({
      ...usageRecord,
      id: expect.any(String),
      occurredAt: expect.any(String),
    });
    const usageWrite = parseWireCopy(writeInput);
    expect(usageWrite).toStrictEqual({ ...writeInput, guardrail: 'input' });

    await expectWrittenOnceAndReplayedAsDuplicate(usageWrite);
  });

  test('omits an empty detector list, so an older writer still accepts the write', async () => {
    const usageRecord = await usageRecordForNewOrganization({ detectorsFired: [] });

    const writeInput = await writeInputFromGateway(usageRecord);

    expect(writeInput).not.toHaveProperty('detectorsFired');
    const usageWrite = parseWireCopy(writeInput);

    await expectWrittenOnceAndReplayedAsDuplicate(usageWrite);
  });

  test('carries a write without an inference usage id', async () => {
    const { microdollarUsageId: _microdollarUsageId, ...usageRecord } =
      await usageRecordForNewOrganization({ decision: 'allowed', apiKind: 'responses' });

    const writeInput = await writeInputFromGateway(usageRecord);

    expect(writeInput).not.toHaveProperty('microdollarUsageId');
    const usageWrite = parseWireCopy(writeInput);
    expect(usageWrite).toStrictEqual({ ...writeInput, guardrail: 'input' });

    await expectWrittenOnceAndReplayedAsDuplicate(usageWrite);
  });
});

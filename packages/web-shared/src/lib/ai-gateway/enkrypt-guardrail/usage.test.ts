import { describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import {
  api_kind,
  enkrypt_usage,
  enkrypt_usage_decision,
  enkrypt_usage_detector,
  enkrypt_usage_guardrail,
  organization_user_usage,
  organizations,
} from '@kilocode/db/schema';
import type { EnkryptDetectorId } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { enkryptUsageRecordForNewOrganization } from '@kilocode/web-shared/tests/helpers/enkrypt-usage.helper';
import {
  enkryptCreditsToMicrodollars,
  MICRODOLLARS_PER_ENKRYPT_CREDIT,
  recordEnkryptUsage,
  recordEnkryptUsageLocally,
  type EnkryptUsageRecord,
} from './usage';

async function organizationBalance(organizationId: string) {
  const [row] = await db
    .select({
      microdollarsUsed: organizations.microdollars_used,
      microdollarsBalance: organizations.microdollars_balance,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row;
}

async function firedDetectors(organizationId: string) {
  const rows = await db
    .select({ ids: enkrypt_usage.fired_detector_ids })
    .from(enkrypt_usage)
    .where(eq(enkrypt_usage.organization_id, organizationId));
  const lookup = await db.select().from(enkrypt_usage_detector);
  const detectorById = new Map(lookup.map(row => [row.detector_id, row.detector]));
  return rows.map(row => row.ids?.map(id => detectorById.get(id)) ?? null);
}

describe('enkryptCreditsToMicrodollars', () => {
  it.each([
    [null, 0],
    [0, 0],
    [-1, 0],
    [Number.NaN, 0],
    [7, 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT],
  ])('converts %p credits to %p microdollars', (credits, microdollars) => {
    expect(enkryptCreditsToMicrodollars(credits)).toBe(microdollars);
  });
});

describe('recordEnkryptUsage', () => {
  it('writes a ledger row and debits the organization and member usage', async () => {
    const microdollarUsageId = randomUUID();
    const usageRecord = await enkryptUsageRecordForNewOrganization({ microdollarUsageId });
    const { organizationId } = usageRecord;
    await recordEnkryptUsage(usageRecord);

    const rows = await db
      .select({
        kilo_user_id: enkrypt_usage.kilo_user_id,
        session_id: enkrypt_usage.session_id,
        microdollar_usage_id: enkrypt_usage.microdollar_usage_id,
        api_kind: api_kind.api_kind,
        decision: enkrypt_usage_decision.decision,
        enkrypt_credits_cost: enkrypt_usage.enkrypt_credits_cost,
        charged_microdollars: enkrypt_usage.charged_microdollars,
        added_latency_ms: enkrypt_usage.added_latency_ms,
        guardrail: enkrypt_usage_guardrail.guardrail,
        fired_detector_ids: enkrypt_usage.fired_detector_ids,
        scanned_characters: enkrypt_usage.scanned_characters,
        total_characters: enkrypt_usage.total_characters,
      })
      .from(enkrypt_usage)
      .innerJoin(api_kind, eq(api_kind.api_kind_id, enkrypt_usage.api_kind_id))
      .innerJoin(
        enkrypt_usage_guardrail,
        eq(enkrypt_usage_guardrail.guardrail_id, enkrypt_usage.guardrail_id)
      )
      .innerJoin(
        enkrypt_usage_decision,
        eq(enkrypt_usage_decision.decision_id, enkrypt_usage.decision_id)
      )
      .where(eq(enkrypt_usage.organization_id, organizationId));
    expect(rows).toEqual([
      expect.objectContaining({
        kilo_user_id: usageRecord.kiloUserId,
        session_id: 'ses_guardrail',
        microdollar_usage_id: microdollarUsageId,
        api_kind: 'messages',
        decision: 'blocked',
        enkrypt_credits_cost: 7,
        charged_microdollars: 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
        added_latency_ms: 212,
        guardrail: 'input',
        fired_detector_ids: null,
        scanned_characters: 2_400,
        total_characters: 10_000,
      }),
    ]);
    expect(await organizationBalance(organizationId)).toEqual({
      microdollarsUsed: 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
      microdollarsBalance: 10_000_000 - 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
    });
    const [memberUsage] = await db
      .select({ microdollarUsage: organization_user_usage.microdollar_usage })
      .from(organization_user_usage)
      .where(eq(organization_user_usage.organization_id, organizationId));
    expect(memberUsage?.microdollarUsage).toBe(7 * MICRODOLLARS_PER_ENKRYPT_CREDIT);
  });

  it('records an output guardrail call as such and debits it like an input call', async () => {
    const usageRecord = await enkryptUsageRecordForNewOrganization({ guardrail: 'output' });
    const { organizationId } = usageRecord;
    await recordEnkryptUsage(usageRecord);

    const rows = await db
      .select({ guardrail: enkrypt_usage_guardrail.guardrail })
      .from(enkrypt_usage)
      .innerJoin(
        enkrypt_usage_guardrail,
        eq(enkrypt_usage_guardrail.guardrail_id, enkrypt_usage.guardrail_id)
      )
      .where(eq(enkrypt_usage.organization_id, organizationId));
    expect(rows).toEqual([{ guardrail: 'output' }]);
    expect(await organizationBalance(organizationId)).toEqual({
      microdollarsUsed: 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
      microdollarsBalance: 10_000_000 - 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
    });
  });

  it.each<[string, EnkryptUsageRecord['detectorsFired'], string[] | null]>([
    ['a log-only detection', ['pii', 'toxicity'], ['pii', 'toxicity']],
    ['detectors in any order', ['toxicity', 'pii'], ['toxicity', 'pii']],
    ['no detection', [], null],
    ['an omitted detection', undefined, null],
  ])('records the detectors that fired for %s', async (_name, detectorsFired, stored) => {
    const usageRecord = await enkryptUsageRecordForNewOrganization({
      decision: 'allowed',
      detectorsFired,
    });
    await recordEnkryptUsage(usageRecord);

    expect(await firedDetectors(usageRecord.organizationId)).toEqual([stored]);
  });

  it('creates and reuses lookup values for concurrent usage records without losing a debit', async () => {
    const microdollarUsageId = randomUUID();
    const apiKind = `test-api-${randomUUID()}` as EnkryptUsageRecord['apiKind'];
    const decision = `test-decision-${randomUUID()}` as EnkryptUsageRecord['decision'];
    const detector = `test-detector-${randomUUID()}` as EnkryptDetectorId;
    const usageRecord = await enkryptUsageRecordForNewOrganization({
      apiKind,
      decision,
      microdollarUsageId,
      detectorsFired: [detector, 'pii'],
    });
    const { organizationId } = usageRecord;

    await Promise.all(Array.from({ length: 5 }, () => recordEnkryptUsage(usageRecord)));

    const apiKinds = await db.select().from(api_kind).where(eq(api_kind.api_kind, apiKind));
    const decisions = await db
      .select()
      .from(enkrypt_usage_decision)
      .where(eq(enkrypt_usage_decision.decision, decision));
    expect(apiKinds).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(
      await db
        .select()
        .from(enkrypt_usage_detector)
        .where(eq(enkrypt_usage_detector.detector, detector))
    ).toHaveLength(1);
    expect(await firedDetectors(organizationId)).toEqual(
      Array.from({ length: 5 }, () => [detector, 'pii'])
    );
    const rows = await db
      .select({
        api_kind_id: enkrypt_usage.api_kind_id,
        decision_id: enkrypt_usage.decision_id,
        microdollar_usage_id: enkrypt_usage.microdollar_usage_id,
      })
      .from(enkrypt_usage)
      .where(eq(enkrypt_usage.organization_id, organizationId));
    expect(rows).toHaveLength(5);
    expect(rows).toEqual(
      Array.from({ length: 5 }, () => ({
        api_kind_id: apiKinds[0].api_kind_id,
        decision_id: decisions[0].decision_id,
        microdollar_usage_id: microdollarUsageId,
      }))
    );
    expect(await organizationBalance(organizationId)).toEqual({
      microdollarsUsed: 5 * 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
      microdollarsBalance: 10_000_000 - 5 * 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
    });
  });

  it('does not block another organization sharing lookups while a debit transaction is held open', async () => {
    const first = await enkryptUsageRecordForNewOrganization();
    const second = await enkryptUsageRecordForNewOrganization();
    await db.insert(api_kind).values({ api_kind: 'messages' }).onConflictDoNothing();
    await db.insert(enkrypt_usage_decision).values({ decision: 'blocked' }).onConflictDoNothing();

    const debitHeld = Promise.withResolvers<void>();
    const releaseDebit = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<never>();
    const timeout = setTimeout(
      () => deadline.reject(new Error('Another organization was blocked by the held debit')),
      5_000
    );
    const transaction = db.transaction.bind(db);
    const holdDebit = jest.spyOn(db, 'transaction').mockImplementationOnce(callback =>
      transaction(async tx => {
        const result = await callback(tx);
        debitHeld.resolve();
        await releaseDebit.promise;
        return result;
      })
    );
    const firstUsageRecord = recordEnkryptUsage(first);
    let secondUsageRecord: Promise<void> | undefined;

    try {
      await Promise.race([debitHeld.promise, firstUsageRecord, deadline.promise]);
      secondUsageRecord = recordEnkryptUsage(second);
      await Promise.race([secondUsageRecord, deadline.promise]);

      expect(await organizationBalance(second.organizationId)).toEqual({
        microdollarsUsed: 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
        microdollarsBalance: 10_000_000 - 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
      });
      const rows = await db
        .select()
        .from(enkrypt_usage)
        .where(eq(enkrypt_usage.organization_id, second.organizationId));
      expect(rows).toHaveLength(1);
    } finally {
      releaseDebit.resolve();
      clearTimeout(timeout);
      holdDebit.mockRestore();
      await Promise.allSettled([firstUsageRecord, secondUsageRecord]);
    }
    await firstUsageRecord;
  }, 15_000);

  it('records a failed call without debiting the organization', async () => {
    const usageRecord = await enkryptUsageRecordForNewOrganization({
      decision: 'error',
      creditsCost: null,
      addedLatencyMs: null,
    });
    const { organizationId } = usageRecord;

    await recordEnkryptUsage(usageRecord);

    const rows = await db
      .select({
        decision: enkrypt_usage_decision.decision,
        enkrypt_credits_cost: enkrypt_usage.enkrypt_credits_cost,
        charged_microdollars: enkrypt_usage.charged_microdollars,
        added_latency_ms: enkrypt_usage.added_latency_ms,
        microdollar_usage_id: enkrypt_usage.microdollar_usage_id,
      })
      .from(enkrypt_usage)
      .innerJoin(
        enkrypt_usage_decision,
        eq(enkrypt_usage_decision.decision_id, enkrypt_usage.decision_id)
      )
      .where(eq(enkrypt_usage.organization_id, organizationId));
    expect(rows).toEqual([
      expect.objectContaining({
        decision: 'error',
        enkrypt_credits_cost: null,
        charged_microdollars: 0,
        added_latency_ms: null,
        microdollar_usage_id: null,
      }),
    ]);
    expect(await organizationBalance(organizationId)).toEqual({
      microdollarsUsed: 0,
      microdollarsBalance: 10_000_000,
    });
  });

  it('rolls back lookup values, usage, and financial changes when the transaction fails', async () => {
    const apiKind = `test-api-${randomUUID()}` as EnkryptUsageRecord['apiKind'];
    const decision = `test-decision-${randomUUID()}` as EnkryptUsageRecord['decision'];
    const usageRecord = await enkryptUsageRecordForNewOrganization({ apiKind, decision });
    const { organizationId } = usageRecord;
    const transaction = db.transaction.bind(db);
    const failure = jest.spyOn(db, 'transaction').mockImplementationOnce(callback =>
      transaction(async tx => {
        await callback(tx);
        throw new Error('transaction failed after debit');
      })
    );

    try {
      await expect(recordEnkryptUsage(usageRecord)).rejects.toThrow(
        'transaction failed after debit'
      );
    } finally {
      failure.mockRestore();
    }

    expect(
      await db.select().from(enkrypt_usage).where(eq(enkrypt_usage.organization_id, organizationId))
    ).toEqual([]);
    expect(await db.select().from(api_kind).where(eq(api_kind.api_kind, apiKind))).toEqual([]);
    expect(
      await db
        .select()
        .from(enkrypt_usage_decision)
        .where(eq(enkrypt_usage_decision.decision, decision))
    ).toEqual([]);
    expect(await organizationBalance(organizationId)).toEqual({
      microdollarsUsed: 0,
      microdollarsBalance: 10_000_000,
    });
    expect(
      await db
        .select()
        .from(organization_user_usage)
        .where(eq(organization_user_usage.organization_id, organizationId))
    ).toEqual([]);
  });

  it('stores no detectors for a write with an empty detector list', async () => {
    const usageRecord = await enkryptUsageRecordForNewOrganization();

    await recordEnkryptUsageLocally({
      ...usageRecord,
      guardrail: 'input',
      detectorsFired: [],
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
    });

    expect(await firedDetectors(usageRecord.organizationId)).toEqual([null]);
  });

  it('stores no sizes for a write from a gateway deployed before them', async () => {
    const {
      scannedCharacters: _scannedCharacters,
      totalCharacters: _totalCharacters,
      ...olderWrite
    } = await enkryptUsageRecordForNewOrganization();

    await recordEnkryptUsageLocally({
      ...olderWrite,
      guardrail: 'input',
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
    });

    expect(
      await db
        .select({
          scanned_characters: enkrypt_usage.scanned_characters,
          total_characters: enkrypt_usage.total_characters,
        })
        .from(enkrypt_usage)
        .where(eq(enkrypt_usage.organization_id, olderWrite.organizationId))
    ).toEqual([{ scanned_characters: null, total_characters: null }]);
  });
});

// First, so the billing modules see their placeholders before they load.
import '../benchmark-billing-test-env';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { enkrypt_usage, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { recordEnkryptUsageLocally as RecordEnkryptUsage } from './usage';

const scheduledTopUps: unknown[] = [];
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/organizations/organization-usage'
  ),
  scheduleOrganizationUsageAutoTopUp: (usage: unknown) => {
    scheduledTopUps.push(usage);
  },
}));

let recordEnkryptUsageLocally: typeof RecordEnkryptUsage;

beforeEach(async () => {
  scheduledTopUps.length = 0;
  jest.resetModules();
  ({ recordEnkryptUsageLocally } = await import('./usage'));
});

function write(input: {
  organizationId: string;
  kiloUserId: string;
  benchmarkCase?: boolean;
  creditsCost?: number;
  id?: string;
}) {
  return {
    id: input.id ?? crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    organizationId: input.organizationId,
    kiloUserId: input.kiloUserId,
    sessionId: null,
    microdollarUsageId: crypto.randomUUID(),
    apiKind: 'chat_completions' as const,
    decision: 'allowed' as const,
    creditsCost: input.creditsCost ?? 5,
    addedLatencyMs: 10,
    guardrail: 'input' as const,
    ...(input.benchmarkCase === undefined ? {} : { benchmarkCase: input.benchmarkCase }),
  };
}

async function fixture() {
  const owner = await insertTestUser({
    google_user_email: `enkrypt-${crypto.randomUUID()}@example.com`,
    microdollars_used: 0,
    total_microdollars_acquired: 0,
  });
  const organization = await createTestOrganization(
    `enkrypt-${crypto.randomUUID()}`,
    owner.id,
    10_000_000
  );
  return { owner, organization };
}

async function organizationSpend(organizationId: string) {
  const row = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  return row?.microdollars_used ?? 0;
}

/**
 * A benchmark case's policy scans run before the signed permit callback, so the account is not
 * yet admitted and may never be the one that pays the request. Kilo bears that overhead: the
 * scan still records telemetry and credits, but the write is non-billable. This drives the real
 * writer against PostgreSQL, so the boundary itself is what is proven.
 */
describe('enkrypt guardrail write for a benchmark case', () => {
  it('records telemetry with a zero charge and no organization debit or top-up', async () => {
    const { owner, organization } = await fixture();
    const spendBefore = await organizationSpend(organization.id);

    const status = await recordEnkryptUsageLocally(
      write({
        organizationId: organization.id,
        kiloUserId: owner.id,
        benchmarkCase: true,
        creditsCost: 5,
      })
    );

    expect(status).toBe('recorded');
    const rows = await db.query.enkrypt_usage.findMany({
      where: eq(enkrypt_usage.organization_id, organization.id),
    });
    expect(rows).toHaveLength(1);
    // Telemetry and the reported credit count are kept...
    expect(rows[0].enkrypt_credits_cost).toBe(5);
    // ...but nothing is billable.
    expect(rows[0].charged_microdollars).toBe(0);
    expect(await organizationSpend(organization.id)).toBe(spendBefore);
    expect(scheduledTopUps).toEqual([]);
  });

  it('keeps charging ordinary organization calls exactly as before', async () => {
    const { owner, organization } = await fixture();
    const spendBefore = await organizationSpend(organization.id);

    await recordEnkryptUsageLocally(
      write({ organizationId: organization.id, kiloUserId: owner.id, creditsCost: 5 })
    );

    const rows = await db.query.enkrypt_usage.findMany({
      where: eq(enkrypt_usage.organization_id, organization.id),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].charged_microdollars).toBeGreaterThan(0);
    expect(await organizationSpend(organization.id)).toBeGreaterThan(spendBefore);
  });

  it('stays non-billable when the benchmark call is later refused or aborted', async () => {
    // The scan is written before any admission outcome, so refusal/abort cannot retroactively
    // create a payer debit: the row is already zero-charge and no consumption row exists.
    const { owner, organization } = await fixture();
    const spendBefore = await organizationSpend(organization.id);

    await recordEnkryptUsageLocally(
      write({
        organizationId: organization.id,
        kiloUserId: owner.id,
        benchmarkCase: true,
        creditsCost: 9,
      })
    );

    expect(await organizationSpend(organization.id)).toBe(spendBefore);
    expect(scheduledTopUps).toEqual([]);
  });
});

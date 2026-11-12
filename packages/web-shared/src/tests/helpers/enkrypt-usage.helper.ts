import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { enkrypt_usage, organizations } from '@kilocode/db/schema';
import type { EnkryptUsageRecord } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

/** A blocked input guardrail call costing 7 credits, by the owner of a new organization. */
export async function enkryptUsageRecordForNewOrganization(
  overrides: Partial<EnkryptUsageRecord> = {}
): Promise<EnkryptUsageRecord> {
  const user = await insertTestUser();
  const organization = await createTestOrganization(
    `enkrypt-guardrail-${randomUUID()}`,
    user.id,
    10_000_000
  );
  return {
    organizationId: organization.id,
    kiloUserId: user.id,
    sessionId: 'ses_guardrail',
    apiKind: 'messages',
    decision: 'blocked',
    creditsCost: 7,
    scannedCharacters: 2_400,
    totalCharacters: 10_000,
    addedLatencyMs: 212,
    ...overrides,
  };
}

export async function enkryptLedgerRows(organizationId: string) {
  return db.select().from(enkrypt_usage).where(eq(enkrypt_usage.organization_id, organizationId));
}

export async function organizationMicrodollarsUsed(organizationId: string) {
  const [row] = await db
    .select({ microdollarsUsed: organizations.microdollars_used })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.microdollarsUsed;
}

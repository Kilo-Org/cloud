import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import {
  enkrypt_guardrail_charges,
  organization_user_usage,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  enkryptCreditsToMicrodollars,
  MICRODOLLARS_PER_ENKRYPT_CREDIT,
  recordEnkryptGuardrailCharge,
  type EnkryptGuardrailCharge,
} from './charges';

async function organizationWithMember() {
  const user = await insertTestUser();
  const organization = await createTestOrganization(
    `enkrypt-guardrail-${randomUUID()}`,
    user.id,
    10_000_000
  );
  return { user, organization };
}

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

function charge(
  organizationId: string,
  kiloUserId: string,
  overrides: Partial<EnkryptGuardrailCharge> = {}
): EnkryptGuardrailCharge {
  return {
    organizationId,
    kiloUserId,
    sessionId: 'ses_guardrail',
    apiKind: 'messages',
    decision: 'blocked',
    creditsCost: 7,
    ...overrides,
  };
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

describe('recordEnkryptGuardrailCharge', () => {
  it('writes a ledger row and debits the organization and member usage', async () => {
    const { user, organization } = await organizationWithMember();
    await recordEnkryptGuardrailCharge(charge(organization.id, user.id));

    const rows = await db
      .select()
      .from(enkrypt_guardrail_charges)
      .where(eq(enkrypt_guardrail_charges.organization_id, organization.id));
    expect(rows).toEqual([
      expect.objectContaining({
        kilo_user_id: user.id,
        session_id: 'ses_guardrail',
        api_kind: 'messages',
        decision: 'blocked',
        enkrypt_credits_cost: 7,
        charged_microdollars: 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
      }),
    ]);
    expect(await organizationBalance(organization.id)).toEqual({
      microdollarsUsed: 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
      microdollarsBalance: 10_000_000 - 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
    });
    const [memberUsage] = await db
      .select({ microdollarUsage: organization_user_usage.microdollar_usage })
      .from(organization_user_usage)
      .where(eq(organization_user_usage.organization_id, organization.id));
    expect(memberUsage?.microdollarUsage).toBe(7 * MICRODOLLARS_PER_ENKRYPT_CREDIT);
  });

  it('sums concurrent charges without losing a debit', async () => {
    const { user, organization } = await organizationWithMember();

    await Promise.all(
      Array.from({ length: 5 }, () =>
        recordEnkryptGuardrailCharge(charge(organization.id, user.id))
      )
    );

    expect(await organizationBalance(organization.id)).toEqual({
      microdollarsUsed: 5 * 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
      microdollarsBalance: 10_000_000 - 5 * 7 * MICRODOLLARS_PER_ENKRYPT_CREDIT,
    });
  });

  it('records a failed call without debiting the organization', async () => {
    const { user, organization } = await organizationWithMember();

    await recordEnkryptGuardrailCharge(
      charge(organization.id, user.id, { decision: 'error', creditsCost: null })
    );

    const rows = await db
      .select()
      .from(enkrypt_guardrail_charges)
      .where(eq(enkrypt_guardrail_charges.organization_id, organization.id));
    expect(rows).toEqual([
      expect.objectContaining({
        decision: 'error',
        enkrypt_credits_cost: null,
        charged_microdollars: 0,
      }),
    ]);
    expect(await organizationBalance(organization.id)).toEqual({
      microdollarsUsed: 0,
      microdollarsBalance: 10_000_000,
    });
  });
});

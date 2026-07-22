import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { cloud_billing_sku, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { serializeCloudBillingSku } from './cloud-billing-skus-router';

let admin: User;
let nonAdmin: User;

beforeEach(async () => {
  await cleanupDbForTest();
  [admin, nonAdmin] = await Promise.all([insertTestUser({ is_admin: true }), insertTestUser()]);
});

function validInput(id: string) {
  return {
    id,
    name: 'Cloud Agent Standard',
    description: 'Container awake time',
    unit: 'second' as const,
    rate_cents_per_unit: '0.123456789012',
  };
}

describe('admin.cloudBillingSkus.list', () => {
  it('allows admins to list SKUs and rejects non-admins', async () => {
    await db.insert(cloud_billing_sku).values({
      ...validInput('cloud-agent-standard'),
      created_by_user_id: admin.id,
    });

    const adminCaller = await createCallerForUser(admin.id);
    await expect(adminCaller.admin.cloudBillingSkus.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'cloud-agent-standard',
        accepts_new_usage: true,
      }),
    ]);

    const nonAdminCaller = await createCallerForUser(nonAdmin.id);
    await expect(nonAdminCaller.admin.cloudBillingSkus.list()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('normalizes production-shaped PostgreSQL timestamps to UTC ISO', () => {
    const serialized = serializeCloudBillingSku({
      id: 'timestamp-sku',
      name: 'Timestamp SKU',
      description: null,
      unit: 'second',
      rate_cents_per_unit: '0.1',
      accepts_new_usage: true,
      created_by_user_id: null,
      created_at: '2026-04-29 01:16:12.945+00',
    });

    expect(serialized.created_at).toBe('2026-04-29T01:16:12.945Z');
  });
});

describe('admin.cloudBillingSkus.create', () => {
  it('requires admin access', async () => {
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(
      caller.admin.cloudBillingSkus.create(validInput('restricted-sku'))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const rows = await db.select().from(cloud_billing_sku);
    expect(rows).toHaveLength(0);
  });

  it('persists the exact rate and authenticated creator', async () => {
    const caller = await createCallerForUser(admin.id);

    await caller.admin.cloudBillingSkus.create(validInput('exact-rate-sku'));

    const [persisted] = await db
      .select()
      .from(cloud_billing_sku)
      .where(eq(cloud_billing_sku.id, 'exact-rate-sku'));
    expect(persisted).toMatchObject({
      id: 'exact-rate-sku',
      rate_cents_per_unit: '0.123456789012',
      created_by_user_id: admin.id,
      accepts_new_usage: true,
    });
  });

  it('returns a canonical rate after PostgreSQL scale padding', async () => {
    const caller = await createCallerForUser(admin.id);

    const created = await caller.admin.cloudBillingSkus.create({
      ...validInput('canonical-rate-sku'),
      rate_cents_per_unit: '1.2300',
    });
    const listed = await caller.admin.cloudBillingSkus.list();

    expect(created.rate_cents_per_unit).toBe('1.23');
    expect(listed.find(sku => sku.id === 'canonical-rate-sku')?.rate_cents_per_unit).toBe('1.23');
    const [persisted] = await db
      .select({ rate: cloud_billing_sku.rate_cents_per_unit })
      .from(cloud_billing_sku)
      .where(eq(cloud_billing_sku.id, 'canonical-rate-sku'));
    expect(persisted.rate).toBe('1.230000000000');
  });

  it('returns CONFLICT for a duplicate SKU ID', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.cloudBillingSkus.create(validInput('duplicate-sku'));

    await expect(
      caller.admin.cloudBillingSkus.create({
        ...validInput('duplicate-sku'),
        name: 'Replacement name',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('admin.cloudBillingSkus.disable', () => {
  it('requires admin access', async () => {
    await db.insert(cloud_billing_sku).values({
      ...validInput('protected-sku'),
      created_by_user_id: admin.id,
    });
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(
      caller.admin.cloudBillingSkus.disable({ id: 'protected-sku' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const [persisted] = await db
      .select({ accepts_new_usage: cloud_billing_sku.accepts_new_usage })
      .from(cloud_billing_sku)
      .where(eq(cloud_billing_sku.id, 'protected-sku'));
    expect(persisted.accepts_new_usage).toBe(true);
  });

  it('only moves a SKU to disabled and remains disabled on repeated calls', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.cloudBillingSkus.create(validInput('one-way-sku'));

    const disabled = await caller.admin.cloudBillingSkus.disable({ id: 'one-way-sku' });
    const disabledAgain = await caller.admin.cloudBillingSkus.disable({ id: 'one-way-sku' });

    expect(disabled.accepts_new_usage).toBe(false);
    expect(disabledAgain.accepts_new_usage).toBe(false);
    const [persisted] = await db
      .select({ accepts_new_usage: cloud_billing_sku.accepts_new_usage })
      .from(cloud_billing_sku)
      .where(eq(cloud_billing_sku.id, 'one-way-sku'));
    expect(persisted.accepts_new_usage).toBe(false);
  });
});

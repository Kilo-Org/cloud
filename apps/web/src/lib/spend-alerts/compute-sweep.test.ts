import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  cloud_billing_sku,
  microdollar_usage,
  compute_usage_charge,
  organizations,
  spend_alert_deliveries,
  spend_alert_hourly,
  spend_alert_rules,
  spend_alert_settings,
} from '@kilocode/db/schema';
import { backfillComputeSpendAlerts } from './compute-backfill';
import { createSpendAlertSweepStore, runSpendAlertSweep, sweepHourlyBuckets } from './sweep';

const HOUR_MS = 3_600_000;

async function fixture() {
  const user = await insertTestUser();
  const skuId = `compute-alert-${crypto.randomUUID()}`;
  await db.insert(cloud_billing_sku).values({
    id: skuId,
    name: 'Compute alert fixture',
    unit: 'second',
    rate_cents_per_unit: '1',
  });
  const now = new Date();
  now.setUTCMinutes(30, 0, 0);
  return { user, skuId, now };
}

describe('compute spend alert PostgreSQL rollup', () => {
  it.each(['personal', 'organization'] as const)(
    'fires one %s threshold from compute alone and rebuilds without double counting',
    async scope => {
      const { user, skuId, now } = await fixture();
      const orgId = scope === 'organization' ? crypto.randomUUID() : null;
      if (orgId !== null) {
        await db.insert(organizations).values({
          id: orgId,
          name: 'Compute alert organization',
          created_by_kilo_user_id: user.id,
        });
      }
      const scopeKey = orgId === null ? `user:${user.id}` : `org:${orgId}`;
      const settingsId = crypto.randomUUID();
      await db.insert(spend_alert_settings).values({
        id: settingsId,
        scope_key: scopeKey,
        kilo_user_id: orgId === null ? user.id : null,
        organization_id: orgId,
        enabled: true,
      });
      await db.insert(spend_alert_rules).values({
        settings_id: settingsId,
        kind: 'threshold',
        threshold_microdollars: 5_000_000,
        window_hours: 24,
      });
      await db.insert(compute_usage_charge).values({
        usage_source: 'compute-alert-test',
        usage_source_id: crypto.randomUUID(),
        user_id: orgId === null ? user.id : null,
        organization_id: orgId,
        cloud_billing_sku_id: skuId,
        quantity: '600',
        rate_cents_per_unit: '1',
        amount_microdollars: 6_000_000,
        created_at: now.toISOString(),
      });
      const store = createSpendAlertSweepStore(db);
      await runSpendAlertSweep(db, { store }, { now });
      await runSpendAlertSweep(db, { store }, { now });
      const deliveries = await db
        .select()
        .from(spend_alert_deliveries)
        .where(eq(spend_alert_deliveries.scope_key, scopeKey));
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].kind).toBe('threshold');
      const buckets = await db
        .select()
        .from(spend_alert_hourly)
        .where(eq(spend_alert_hourly.scope_key, scopeKey));
      expect(buckets).toHaveLength(1);
      expect(buckets[0].cost_microdollars).toBe(6_000_000);
    }
  );

  it('combines model and compute spend in one bucket without double counting on rebuild', async () => {
    const { user, skuId, now } = await fixture();
    await db.insert(microdollar_usage).values({
      kilo_user_id: user.id,
      cost: 2_000_000,
      input_tokens: 1,
      output_tokens: 1,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: now.toISOString(),
    });
    await db.insert(compute_usage_charge).values({
      usage_source: 'compute-alert-test',
      usage_source_id: crypto.randomUUID(),
      user_id: user.id,
      cloud_billing_sku_id: skuId,
      quantity: '300',
      rate_cents_per_unit: '1',
      amount_microdollars: 3_000_000,
      created_at: now.toISOString(),
    });
    await sweepHourlyBuckets(db, { now });
    await sweepHourlyBuckets(db, { now });
    const buckets = await db
      .select()
      .from(spend_alert_hourly)
      .where(eq(spend_alert_hourly.scope_key, `user:${user.id}`));
    expect(buckets).toHaveLength(1);
    expect(buckets[0].cost_microdollars).toBe(5_000_000);
  });

  it.each(['personal', 'organization'] as const)(
    'backfills only compute scopes, including historical model spend for %s payers',
    async scope => {
      const { user, skuId, now } = await fixture();
      const other = await insertTestUser();
      const orgId = scope === 'organization' ? crypto.randomUUID() : null;
      if (orgId)
        await db.insert(organizations).values({
          id: orgId,
          name: 'Backfill payer',
          created_by_kilo_user_id: user.id,
        });
      const scopeKey = orgId ? `org:${orgId}` : `user:${user.id}`;
      const historical = new Date(now.getTime() - 719 * HOUR_MS);
      const hour = new Date(historical);
      hour.setUTCMinutes(0, 0, 0);
      await db.insert(microdollar_usage).values([
        {
          kilo_user_id: user.id,
          organization_id: orgId,
          cost: 2_000_000,
          input_tokens: 1,
          output_tokens: 1,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: historical.toISOString(),
        },
        {
          kilo_user_id: other.id,
          cost: 9_000_000,
          input_tokens: 1,
          output_tokens: 1,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: historical.toISOString(),
        },
      ]);
      await db.insert(compute_usage_charge).values({
        usage_source: 'compute-backfill-test',
        usage_source_id: crypto.randomUUID(),
        user_id: orgId ? null : user.id,
        organization_id: orgId,
        cloud_billing_sku_id: skuId,
        quantity: '300',
        rate_cents_per_unit: '1',
        amount_microdollars: 3_000_000,
        created_at: historical.toISOString(),
      });
      // Deliberately stale: a full rebuild would change this unrelated payer.
      await db.insert(spend_alert_hourly).values({
        scope_key: `user:${other.id}`,
        hour_start: hour.toISOString(),
        cost_microdollars: 1,
      });
      await backfillComputeSpendAlerts(db, now);
      await backfillComputeSpendAlerts(db, now);
      const affected = await db
        .select()
        .from(spend_alert_hourly)
        .where(eq(spend_alert_hourly.scope_key, scopeKey));
      expect(affected).toHaveLength(1);
      expect(affected[0].cost_microdollars).toBe(5_000_000);
      const unrelated = await db
        .select()
        .from(spend_alert_hourly)
        .where(eq(spend_alert_hourly.scope_key, `user:${other.id}`));
      expect(unrelated[0].cost_microdollars).toBe(1);
    }
  );

  it('includes historical compute in the anomaly baseline and fires once for a compute-only increase', async () => {
    const { user, skuId, now } = await fixture();
    const scopeKey = `user:${user.id}`;
    const settingsId = crypto.randomUUID();
    await db
      .insert(spend_alert_settings)
      .values({ id: settingsId, scope_key: scopeKey, kilo_user_id: user.id, enabled: true });
    await db
      .insert(spend_alert_rules)
      .values({ settings_id: settingsId, kind: 'anomaly', multiplier_basis_points: 300 });
    await db.insert(compute_usage_charge).values(
      Array.from({ length: 25 }, (_, hour) => ({
        usage_source: 'compute-alert-test',
        usage_source_id: crypto.randomUUID(),
        user_id: user.id,
        cloud_billing_sku_id: skuId,
        quantity: hour === 0 ? '600' : '100',
        rate_cents_per_unit: '1',
        amount_microdollars: hour === 0 ? 6_000_000 : 1_000_000,
        created_at: new Date(now.getTime() - hour * HOUR_MS).toISOString(),
      }))
    );
    await sweepHourlyBuckets(db, { now, lookbackHours: 336 });
    const store = createSpendAlertSweepStore(db);
    const snapshot = (await store.loadScopeSnapshots([scopeKey], now)).get(scopeKey);
    expect(snapshot?.baselineHourlyMicrodollars).toBe(1_000_000);
    expect(snapshot?.currentHourMicrodollars).toBe(6_000_000);
    await runSpendAlertSweep(db, { store }, { now });
    await runSpendAlertSweep(db, { store }, { now });
    const deliveries = await db
      .select()
      .from(spend_alert_deliveries)
      .where(eq(spend_alert_deliveries.scope_key, scopeKey));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].kind).toBe('anomaly');
  });
});

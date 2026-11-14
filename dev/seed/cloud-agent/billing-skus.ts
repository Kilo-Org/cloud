import { cloud_billing_sku } from '@kilocode/db';
import { SANDBOX_USAGE_SKUS } from '@kilocode/worker-utils/cloud-agent-compute';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';

export async function run(...args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: pnpm dev:seed cloud-agent:billing-skus');
    console.log('Creates missing local Cloud Agent billing SKUs with a synthetic test rate.');
    return;
  }
  assertLocalSeedDatabase('cloud-agent:billing-skus');
  const rows = Object.values(SANDBOX_USAGE_SKUS).map(
    id =>
      ({
        id,
        name: `Local ${id}`,
        description: 'dev-seed: synthetic Cloud Agent compute rate; not production pricing',
        unit: 'second',
        rate_cents_per_unit: '0.001',
        accepts_new_usage: true,
      }) satisfies typeof cloud_billing_sku.$inferInsert
  );
  const inserted = await getSeedDb()
    .insert(cloud_billing_sku)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: cloud_billing_sku.id });
  console.log('Existing immutable SKU rates and admission settings are preserved.');
  return { catalogSize: rows.length, inserted: inserted.length };
}

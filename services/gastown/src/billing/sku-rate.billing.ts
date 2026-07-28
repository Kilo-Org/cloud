import { cloud_billing_sku } from '@kilocode/db/schema';
import { getWorkerDb } from '@kilocode/db/client';
import { eq } from 'drizzle-orm';

export async function getSkuHourlyCharge(
  connectionString: string,
  skuId: string
): Promise<number | undefined> {
  const db = getWorkerDb(connectionString, { statement_timeout: 5_000 });
  const [sku] = await db
    .select({ rateCentsPerSecond: cloud_billing_sku.rate_cents_per_unit })
    .from(cloud_billing_sku)
    .where(eq(cloud_billing_sku.id, skuId))
    .limit(1);
  if (!sku) return undefined;

  return hourlyChargeFromRate(sku.rateCentsPerSecond);
}

export function hourlyChargeFromRate(rate: string): number | undefined {
  const rateCentsPerSecond = Number(rate);
  if (!Number.isFinite(rateCentsPerSecond) || rateCentsPerSecond <= 0) return undefined;
  return (rateCentsPerSecond * 3600) / 100;
}

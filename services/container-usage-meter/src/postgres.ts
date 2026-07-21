import { cloud_billing_sku, getWorkerDb, type WorkerDb } from '@kilocode/db';
import type { RecordStartFailureCode } from '@kilocode/container-usage';
import { eq } from 'drizzle-orm';

export function getContainerUsageDb(env: Cloudflare.Env): WorkerDb {
  return getWorkerDb(env.HYPERDRIVE.connectionString);
}

export type StartSkuAdmission =
  | { accepted: true }
  | {
      accepted: false;
      code: RecordStartFailureCode;
      message: string;
    };

export async function validateStartSku(
  env: Cloudflare.Env,
  skuId: string
): Promise<StartSkuAdmission> {
  const [sku] = await getContainerUsageDb(env)
    .select({
      unit: cloud_billing_sku.unit,
      acceptsNewUsage: cloud_billing_sku.accepts_new_usage,
    })
    .from(cloud_billing_sku)
    .where(eq(cloud_billing_sku.id, skuId))
    .limit(1);

  if (!sku) {
    return { accepted: false, code: 'sku_not_found', message: 'Billing SKU not found' };
  }
  if (sku.unit !== 'second') {
    return {
      accepted: false,
      code: 'sku_unit_mismatch',
      message: 'Billing SKU is not measured in seconds',
    };
  }
  if (!sku.acceptsNewUsage) {
    return {
      accepted: false,
      code: 'sku_not_accepting_new_usage',
      message: 'Billing SKU is not accepting new usage',
    };
  }
  return { accepted: true };
}

import { reconcileStaleIntervals } from './postgres';

export const CONTAINER_USAGE_RECONCILIATION_CRON = '*/5 * * * *';

export async function runReconciliation(env: Cloudflare.Env): Promise<void> {
  const reconciledIntervals = await reconcileStaleIntervals(env);
  console.log(
    JSON.stringify({
      message: 'Container usage reconciliation completed',
      event: 'container_usage_reconciliation',
      reconciledIntervals,
    })
  );
}
